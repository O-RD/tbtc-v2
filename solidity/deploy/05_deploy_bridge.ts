import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments, getNamedAccounts } = hre
  const { deploy } = deployments
  const { deployer, treasury } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const LightRelay = await deployments.get("LightRelay")

  // TODO: Test for mainnet deployment that when `WalletRegistry` is provided
  // in `external/mainnet/` directory it gets resolved correctly, and the deployment
  // script from `@keep-network/ecdsa` is not invoked once again.
  const WalletRegistry = await deployments.get("WalletRegistry")

  const ReimbursementPool = await deployments.get("ReimbursementPool")

  // For local tests use `1`.
  const txProofDifficultyFactor =
    deployments.getNetworkName() === "hardhat" ||
    deployments.getNetworkName() === "development"
      ? 1
      : 6

  const deployOptions: DeployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }

  const Deposit = await deploy("Deposit", deployOptions)
  const DepositSweep = await deploy("DepositSweep", deployOptions)
  const Redemption = await deploy("Redemption", deployOptions)
  const Wallets = await deploy("Wallets", {
    contract: "contracts/bridge/Wallets.sol:Wallets",
    ...deployOptions,
  })
  const Fraud = await deploy("Fraud", deployOptions)
  const MovingFunds = await deploy("MovingFunds", deployOptions)

  const [bridge] = await helpers.upgrades.deployProxy("Bridge", {
    contractName:
      process.env.TEST_USE_STUBS_TBTC === "true" ? "BridgeStub" : undefined,
    initializerArgs: [
      Bank.address,
      LightRelay.address,
      treasury,
      WalletRegistry.address,
      ReimbursementPool.address,
      txProofDifficultyFactor,
    ],
    factoryOpts: {
      signer: await ethers.getSigner(deployer),
      libraries: {
        Deposit: Deposit.address,
        DepositSweep: DepositSweep.address,
        Redemption: Redemption.address,
        Wallets: Wallets.address,
        Fraud: Fraud.address,
        MovingFunds: MovingFunds.address,
      },
    },
    proxyOpts: {
      kind: "transparent",
      // Allow external libraries linking. We need to ensure manually that the
      // external  libraries we link are upgrade safe, as the OpenZeppelin plugin
      // doesn't perform such a validation yet.
      // See: https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#why-cant-i-use-external-libraries
      unsafeAllow: ["external-library-linking"],
    },
  })

  // TODO: Take proxyDeployment and use it for Etherscan verification.

  if (hre.network.tags.tenderly) {
    await hre.tenderly.verify({
      name: "Bridge",
      address: bridge.address,
    })
  }
}

export default func

func.tags = ["Bridge"]
func.dependencies = ["Bank", "LightRelay", "Treasury", "WalletRegistry"]
