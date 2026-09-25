import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Contract,
  SorobanRpc,
  BASE_FEE,
  Account,
} from '@stellar/stellar-sdk';

@Injectable()
export class SorobanClientService {
  private readonly logger = new Logger(SorobanClientService.name);
  private readonly server: SorobanRpc.Server;
  private readonly contractId: string;
  private readonly networkPassphrase: string;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL', 'https://soroban-testnet.stellar.org');
    this.server = new SorobanRpc.Server(rpcUrl);
    this.contractId = this.configService.get<string>('CHIOMA_CONTRACT_ID', '');
    this.networkPassphrase = this.getNetworkPassphrase();
    if (!this.contractId) this.logger.warn('CHIOMA_CONTRACT_ID not set - on-chain features will be disabled');
  }

  getServer(): SorobanRpc.Server { return this.server; }
  getContractId(): string { return this.contractId; }
  getNetworkPassphraseValue(): string { return this.networkPassphrase; }
  getBaseFee(): string { return BASE_FEE; }

  private getNetworkPassphrase(): string {
    return this.configService.get<string>('STELLAR_NETWORK', 'testnet') === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  }

  getServerKeypair(): Keypair {
    const secretKey = this.configService.get<string>('SERVER_STELLAR_SECRET');
    if (!secretKey) throw new InternalServerErrorException('SERVER_STELLAR_SECRET environment variable is not set');
    return Keypair.fromSecret(secretKey);
  }

  async getAccount(publicKey: string): Promise<Account> { return await this.server.getAccount(publicKey); }
  getContract(): Contract { this.ensureContractId(); return new Contract(this.contractId); }
  createTransactionBuilder(account: Account): TransactionBuilder { return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }); }

  private async waitForTransaction(txHash: string, maxAttempts = 5): Promise<SorobanRpc.Api.GetTransactionResponse> {
    let response = await this.server.getTransaction(txHash);
    for (let attempt = 0; response.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && attempt < maxAttempts; attempt++) {
      await this.sleep(1000 * 2 ** attempt);
      response = await this.server.getTransaction(txHash);
    }
    return response;
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof BadRequestException)) return true;
    const message = JSON.stringify(error.getResponse()).toLowerCase();
    return !message.includes('invalid') && !message.includes('validation');
  }

  async submitTransaction(transaction: ReturnType<TransactionBuilder['build']>, signerKeypair: Keypair): Promise<string> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const simulateResponse = await this.server.simulateTransaction(transaction);
        if (SorobanRpc.Api.isSimulationError(simulateResponse)) throw new BadRequestException(`Transaction simulation failed: ${simulateResponse.error}`);
        if (!SorobanRpc.Api.isSimulationSuccess(simulateResponse)) throw new BadRequestException('Transaction simulation failed');
        const preparedTx = SorobanRpc.assembleTransaction(transaction, simulateResponse).build();
        preparedTx.sign(signerKeypair);
        const sendResponse = await this.server.sendTransaction(preparedTx);
        if (sendResponse.status === 'ERROR') throw new BadRequestException(`Failed to submit transaction: ${JSON.stringify(sendResponse.errorResult)}`);
        const txHash = sendResponse.hash;
        const result = await this.waitForTransaction(txHash);
        if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          this.logger.log(`Transaction successful: ${txHash}`);
          return txHash;
        }
        if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) throw new BadRequestException(`Transaction failed: ${txHash}`);
        throw new Error(`Transaction status unresolved: ${txHash}`);
      } catch (error) {
        if (!this.isRetryable(error) || attempt === 5) throw error;
        this.logger.warn(`Soroban transaction retry ${attempt}/5`, error instanceof Error ? error.message : String(error));
        await this.sleep(1000 * attempt);
      }
    }
    throw new BadRequestException('Soroban transaction failed after retries');
  }

  async simulateTransaction(transaction: ReturnType<TransactionBuilder['build']>): Promise<SorobanRpc.Api.SimulateTransactionResponse> { return await this.server.simulateTransaction(transaction); }
  ensureContractId(): void { if (!this.contractId) throw new BadRequestException('On-chain features are not configured. CHIOMA_CONTRACT_ID is not set.'); }
  verifyStellarAddress(address: string): boolean { return !!address && /^G[A-Z2-7]{55}$/.test(address); }
  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}
