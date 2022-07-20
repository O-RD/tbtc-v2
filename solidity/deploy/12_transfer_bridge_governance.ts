import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
  const { deployer } = await getNamedAccounts()

  const BridgeGovernance = await deployments.get("BridgeGovernance")

  deployments.log(
    `transferring Bridge governance to: ${BridgeGovernance.address}`
  )

  await deployments.execute(
    "Bridge",
    { from: deployer },
    "transferGovernance",
    BridgeGovernance.address
  )
}

export default func

func.tags = ["TransferBridgeGovernance"]
func.dependencies = ["Bridge"]
func.runAtTheEnd = true
