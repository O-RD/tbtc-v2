import bcoin from "bcoin"
import {
  Client as BitcoinClient,
  RawTransaction,
  Transaction,
  TransactionHash,
  TransactionInput,
  TransactionMerkleBranch,
  TransactionOutput,
  UnspentTransactionOutput,
} from "./bitcoin"
import Electrum from "electrum-client-js"
import sha256 from "bcrypto/lib/sha256-browser.js"
import { BigNumber } from "ethers"
import { URL } from "url"
import { Hex } from "./hex"

/**
 * Represents a set of credentials required to establish an Electrum connection.
 */
export interface Credentials {
  /**
   * Host pointing to the Electrum server.
   */
  host: string
  /**
   * Port the Electrum server listens on.
   */
  port: number
  /**
   * Protocol used by the Electrum server.
   */
  protocol: "tcp" | "tls" | "ssl" | "ws" | "wss"
}

/**
 * Additional options used by the Electrum server.
 */
export type ClientOptions = object

/**
 * Represents an action that makes use of the Electrum connection. An action
 * is supposed to take a proper Electrum connection, do the work, and return
 * a promise holding the outcome of given type.
 */
type Action<T> = (electrum: any) => Promise<T>

/**
 * Electrum-based implementation of the Bitcoin client.
 */
export class Client implements BitcoinClient {
  private credentials: Credentials
  private options?: ClientOptions

  constructor(credentials: Credentials, options?: ClientOptions) {
    this.credentials = credentials
    this.options = options
  }

  /**
   * Creates an Electrum client instance from a URL.
   * @param url - Connection URL.
   * @param options - Additional options used by the Electrum server.
   * @returns Electrum client instance.
   */
  static fromUrl(url: string, options?: ClientOptions): Client {
    const credentials = this.parseElectrumCredentials(url)
    return new Client(credentials, options)
  }

  /**
   * Create Electrum credentials by parsing an URL.
   * @param url - URL to be parsed.
   * @returns Electrum credentials object.
   */
  private static parseElectrumCredentials(url: string): Credentials {
    const urlObj = new URL(url)

    return {
      host: urlObj.hostname,
      port: Number.parseInt(urlObj.port, 10),
      protocol: urlObj.protocol.replace(":", "") as
        | "tcp"
        | "tls"
        | "ssl"
        | "ws"
        | "wss",
    }
  }

  /**
   * Initiates an Electrum connection and uses it to feed the given action.
   * Closes the connection regardless of the action outcome.
   * @param action - Action that makes use of the Electrum connection.
   * @returns Promise holding the outcome.
   */
  private async withElectrum<T>(action: Action<T>): Promise<T> {
    const electrum = new Electrum(
      this.credentials.host,
      this.credentials.port,
      this.credentials.protocol,
      this.options
    )

    try {
      console.log("Connecting to Electrum server...")
      await electrum.connect("tbtc-v2", "1.4.2")
    } catch (error) {
      throw new Error(`Electrum server connection failure: [${error}]`)
    }

    try {
      return await action(electrum)
    } catch (error) {
      throw new Error(`Electrum action failure: [${error}]`)
    } finally {
      console.log("Closing connection to Electrum server...")
      electrum.close()
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#findAllUnspentTransactionOutputs}
   */
  findAllUnspentTransactionOutputs(
    address: string
  ): Promise<UnspentTransactionOutput[]> {
    return this.withElectrum<UnspentTransactionOutput[]>(
      async (electrum: any) => {
        const script = bcoin.Script.fromAddress(address).toRaw().toString("hex")

        const unspentTransactions =
          await electrum.blockchain_scripthash_listunspent(
            computeScriptHash(script)
          )

        return unspentTransactions.reverse().map((tx: any) => ({
          transactionHash: TransactionHash.from(tx.tx_hash),
          outputIndex: tx.tx_pos,
          value: BigNumber.from(tx.value),
        }))
      }
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransaction}
   */
  getTransaction(transactionHash: TransactionHash): Promise<Transaction> {
    return this.withElectrum<Transaction>(async (electrum: any) => {
      // We cannot use `blockchain_transaction_get` with `verbose = true` argument
      // to get the the transaction details as Esplora/Electrs doesn't support verbose
      // transactions.
      // See: https://github.com/Blockstream/electrs/pull/36
      const rawTransaction = await electrum.blockchain_transaction_get(
        transactionHash.toString(),
        false
      )

      if (!rawTransaction) {
        throw new Error(`Transaction not found`)
      }

      // Decode the raw transaction.
      const transaction = bcoin.TX.fromRaw(rawTransaction, "hex")

      const inputs = transaction.inputs.map(
        (input: any): TransactionInput => ({
          transactionHash: TransactionHash.from(input.prevout.hash).reverse(),
          outputIndex: input.prevout.index,
          scriptSig: Hex.from(input.script.toRaw()),
        })
      )

      const outputs = transaction.outputs.map(
        (output: any, i: number): TransactionOutput => ({
          outputIndex: i,
          value: BigNumber.from(output.value),
          scriptPubKey: Hex.from(output.script.toRaw()),
        })
      )

      return {
        transactionHash: TransactionHash.from(transaction.hash()).reverse(),
        inputs: inputs,
        outputs: outputs,
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getRawTransaction}
   */
  getRawTransaction(transactionHash: TransactionHash): Promise<RawTransaction> {
    return this.withElectrum<RawTransaction>(async (electrum: any) => {
      const transaction = await electrum.blockchain_transaction_get(
        transactionHash.toString(),
        false
      )

      return {
        transactionHex: transaction,
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransactionConfirmations}
   */
  getTransactionConfirmations(
    transactionHash: TransactionHash
  ): Promise<number> {
    // We cannot use `blockchain_transaction_get` with `verbose = true` argument
    // to get the the transaction details as Esplora/Electrs doesn't support verbose
    // transactions.
    // See: https://github.com/Blockstream/electrs/pull/36

    return this.withElectrum<number>(async (electrum: any) => {
      const rawTransaction: string = await electrum.blockchain_transaction_get(
        transactionHash.toString(),
        false
      )

      // Decode the raw transaction.
      const transaction = bcoin.TX.fromRaw(rawTransaction, "hex")

      // As a workaround for the problem described in https://github.com/Blockstream/electrs/pull/36
      // we need to calculate the number of confirmations based on the latest
      // block height and block height of the transaction.
      // Electrum protocol doesn't expose a function to get the transaction's block
      // height (other that the `GetTransaction` that is unsupported by Esplora/Electrs).
      // To get the block height of the transaction we query the history of transactions
      // for the output script hash, as the history contains the transaction's block
      // height.

      // Initialize txBlockHeigh with minimum int32 value to identify a problem when
      // a block height was not found in a history of any of the script hashes.
      //
      // The history is expected to return a block height for confirmed transaction.
      // If a transaction is unconfirmed (is still in the mempool) the height will
      // have a value of `0` or `-1`.
      let txBlockHeight: number = Math.min()
      for (const output of transaction.outputs) {
        const scriptHash: Buffer = output.script.sha256()

        type HistoryEntry = {
          // eslint-disable-next-line camelcase
          tx_hash: string
          height: number
        }

        const scriptHashHistory: HistoryEntry[] =
          await electrum.blockchain_scripthash_getHistory(
            scriptHash.reverse().toString("hex")
          )

        const tx = scriptHashHistory.find(
          (t) => t.tx_hash === transactionHash.toString()
        )

        if (tx) {
          txBlockHeight = tx.height
          break
        }
      }

      // History querying didn't come up with the transaction's block height. Return
      // an error.
      if (txBlockHeight === Math.min()) {
        throw new Error(
          "failed to find the transaction block height in script hashes' histories"
        )
      }

      // If the block height is greater than `0` the transaction is confirmed.
      if (txBlockHeight > 0) {
        const latestBlockHeight: number = await this.latestBlockHeight()

        if (latestBlockHeight >= txBlockHeight) {
          // Add `1` to the calculated difference as if the transaction block
          // height equals the latest block height the transaction is already
          // confirmed, so it has one confirmation.
          return latestBlockHeight - txBlockHeight + 1
        }
      }

      return 0
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#latestBlockHeight}
   */
  latestBlockHeight(): Promise<number> {
    return this.withElectrum<number>(async (electrum: any) => {
      const header = await electrum.blockchain_headers_subscribe()

      return header.height
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getHeadersChain}
   */
  getHeadersChain(blockHeight: number, chainLength: number): Promise<string> {
    return this.withElectrum<string>(async (electrum: any) => {
      const headersChain = await electrum.blockchain_block_headers(
        blockHeight,
        chainLength + 1
      )

      return headersChain.hex
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransactionMerkle}
   */
  getTransactionMerkle(
    transactionHash: TransactionHash,
    blockHeight: number
  ): Promise<TransactionMerkleBranch> {
    return this.withElectrum<TransactionMerkleBranch>(async (electrum: any) => {
      const merkle = await electrum.blockchain_transaction_getMerkle(
        transactionHash.toString(),
        blockHeight
      )

      return {
        blockHeight: merkle.block_height,
        merkle: merkle.merkle,
        position: merkle.pos,
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#broadcast}
   */
  broadcast(transaction: RawTransaction): Promise<void> {
    return this.withElectrum<void>(async (electrum: any) => {
      await electrum.blockchain_transaction_broadcast(
        transaction.transactionHex
      )
    })
  }
}

/**
 * Converts a Bitcoin script to an Electrum script hash. See
 * [Electrum protocol]{@link https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes}
 * @param script - Bitcoin script as hex string
 * @returns Electrum script hash as a hex string.
 */
function computeScriptHash(script: string): string {
  return sha256.digest(Buffer.from(script, "hex")).reverse().toString("hex")
}
