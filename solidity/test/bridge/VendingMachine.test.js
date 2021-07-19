const { expect } = require("chai")
const {
  increaseTime,
  to1e18,
  to1ePrecision,
  ZERO_ADDRESS,
  getBlockTime,
} = require("../helpers/contract-test-helpers")

describe("VendingMachine", () => {
  let tbtcV1
  let tbtcV2
  let vendingMachine

  let governance
  let tokenHolder
  let thirdParty

  const unmintFee = to1ePrecision(1, 15) // 0.001
  const initialBalance = to1e18(5) // 5 TBTC v1

  beforeEach(async () => {
    ;[
      deployer,
      unmintFeeUpdateInitiator,
      vendingMachineUpgradeInitiator,
      governance,
      tokenHolder,
      thirdParty,
    ] = await ethers.getSigners()

    const TestERC20 = await ethers.getContractFactory("TestERC20")
    tbtcV1 = await TestERC20.deploy()
    await tbtcV1.deployed()

    const TBTCToken = await ethers.getContractFactory("TBTCToken")
    tbtcV2 = await TBTCToken.deploy()
    await tbtcV2.deployed()

    await tbtcV1.mint(tokenHolder.address, initialBalance)

    const VendingMachine = await ethers.getContractFactory("VendingMachine")
    vendingMachine = await VendingMachine.deploy(
      tbtcV1.address,
      tbtcV2.address,
      unmintFee
    )
    await vendingMachine.deployed()

    await vendingMachine.connect(deployer).transferOwnership(governance.address)
    await vendingMachine
      .connect(deployer)
      .transferUnmintFeeUpdateInitiatorRole(unmintFeeUpdateInitiator.address)
    await vendingMachine
      .connect(deployer)
      .transferVendingMachineUpgradeInitiatorRole(
        vendingMachineUpgradeInitiator.address
      )
    await tbtcV2.connect(deployer).transferOwnership(vendingMachine.address)

    await tbtcV1
      .connect(tokenHolder)
      .approve(vendingMachine.address, initialBalance)
  })

  describe("mint", () => {
    context("when TBTC v1 owner has not enough tokens", () => {
      it("should revert", async () => {
        const amount = initialBalance.add(1)
        await tbtcV1
          .connect(tokenHolder)
          .approve(vendingMachine.address, amount)
        await expect(
          vendingMachine.connect(tokenHolder).mint(amount)
        ).to.be.revertedWith("Transfer amount exceeds balance")
      })
    })

    context("when TBTC v1 owner has enough tokens", () => {
      let tx

      context("when minting entire allowance", () => {
        const amount = initialBalance

        beforeEach(async () => {
          tx = await vendingMachine.connect(tokenHolder).mint(amount)
        })

        it("should mint the same amount of TBTC v2", async () => {
          expect(await tbtcV2.balanceOf(tokenHolder.address)).is.equal(amount)
        })

        it("should transfer TBTC v1 tokens to the VendingMachine", async () => {
          expect(await tbtcV1.balanceOf(vendingMachine.address)).is.equal(
            amount
          )
        })

        it("should emit Minted event", async () => {
          await expect(tx)
            .to.emit(vendingMachine, "Minted")
            .withArgs(tokenHolder.address, amount)
        })
      })

      context("when minting part of the allowance", () => {
        const amount = initialBalance.sub(to1e18(1))

        beforeEach(async () => {
          tx = await vendingMachine.connect(tokenHolder).mint(amount)
        })

        it("should mint the same amount of TBTC v2", async () => {
          expect(await tbtcV2.balanceOf(tokenHolder.address)).is.equal(amount)
        })

        it("should transfer TBTC v1 tokens to the VendingMachine", async () => {
          expect(await tbtcV1.balanceOf(vendingMachine.address)).is.equal(
            amount
          )
        })

        it("should emit Minted event", async () => {
          await expect(tx)
            .to.emit(vendingMachine, "Minted")
            .withArgs(tokenHolder.address, amount)
        })
      })
    })
  })

  describe("receiveApproval", () => {
    context("when called directly", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(tokenHolder)
            .receiveApproval(
              tokenHolder.address,
              initialBalance,
              tbtcV1.address,
              []
            )
        ).to.be.revertedWith("Only TBTC v1 caller allowed")
      })
    })

    context("when called not for TBTC v1 token", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(tokenHolder)
            .receiveApproval(
              tokenHolder.address,
              initialBalance,
              tbtcV2.address,
              []
            )
        ).to.be.revertedWith("Token is not TBTC v1")
      })
    })

    context("when called via approveAndCall", () => {
      let tx

      beforeEach(async () => {
        tx = await tbtcV1
          .connect(tokenHolder)
          .approveAndCall(vendingMachine.address, initialBalance, [])
      })

      it("should mint TBTC v2 to the caller", async () => {
        expect(await tbtcV2.balanceOf(tokenHolder.address)).is.equal(
          initialBalance
        )
      })

      it("should transfer TBTC v1 tokens to the VendingMachine", async () => {
        expect(await tbtcV1.balanceOf(vendingMachine.address)).is.equal(
          initialBalance
        )
      })

      it("should emit Minted event", async () => {
        await expect(tx)
          .to.emit(vendingMachine, "Minted")
          .withArgs(tokenHolder.address, initialBalance)
      })
    })
  })

  describe("unmint", () => {
    beforeEach(async () => {
      await vendingMachine.connect(tokenHolder).mint(initialBalance)
      await tbtcV2
        .connect(tokenHolder)
        .approve(vendingMachine.address, initialBalance)
    })

    context("when unmint fee is zero", () => {
      beforeEach(async () => {
        await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .initiateUnmintFeeUpdate(0)
        await increaseTime(604800) // +7 days contract governance delay
        await vendingMachine.connect(governance).finalizeUnmintFeeUpdate()
      })

      context("when TBTC v2 owner has not enough tokens", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine.connect(tokenHolder).unmint(initialBalance.add(1))
          ).to.be.revertedWith("Amount + fee exceeds TBTC v2 balance")
        })
      })

      context("when TBTC v2 owner has enough tokens", () => {
        context("when unminting entire TBTC v2 balance", () => {
          const unmintAmount = initialBalance
          let v1StartBalance
          let v2StartBalance
          let tx

          beforeEach(async () => {
            v1StartBalance = await tbtcV1.balanceOf(tokenHolder.address)
            v2StartBalance = await tbtcV2.balanceOf(tokenHolder.address)
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          it("should transfer no TBTC v2 to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(0)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(await tbtcV2.balanceOf(tokenHolder.address)).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(await tbtcV1.balanceOf(tokenHolder.address)).to.equal(
              v1StartBalance.add(unmintAmount)
            )
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(tokenHolder.address, unmintAmount, 0)
          })
        })

        context("when unminting part of TBTC v2 balance", () => {
          const unmintAmount = to1e18(1)
          let v1StartBalance
          let v2StartBalance
          let tx

          beforeEach(async () => {
            v1StartBalance = await tbtcV1.balanceOf(tokenHolder.address)
            v2StartBalance = await tbtcV2.balanceOf(tokenHolder.address)
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          it("should transfer no TBTC v2 to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(0)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(await tbtcV2.balanceOf(tokenHolder.address)).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(await tbtcV1.balanceOf(tokenHolder.address)).to.equal(
              v1StartBalance.add(unmintAmount)
            )
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(tokenHolder.address, unmintAmount, 0)
          })
        })
      })
    })

    context("when unmint fee is non-zero", () => {
      context("when TBTC v2 owner has not enough tokens", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine.connect(tokenHolder).unmint(initialBalance)
          ).to.be.revertedWith("Amount + fee exceeds TBTC v2 balance")
        })
      })

      context("when TBTC v2 owner has enough tokens", () => {
        context("when unminting entire TBTC v2 balance", () => {
          // 1e18 * balance / (1e18 + unmintFee)
          const unmintAmount = initialBalance
            .mul(to1e18(1))
            .div(to1e18(1).add(unmintFee))

          let fee
          let v1StartBalance
          let v2StartBalance
          let tx

          beforeEach(async () => {
            v1StartBalance = await tbtcV1.balanceOf(tokenHolder.address)
            v2StartBalance = await tbtcV2.balanceOf(tokenHolder.address)
            fee = await vendingMachine.unmintFeeFor(unmintAmount)
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          it("should transfer TBTC v2 fee to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(fee)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(await tbtcV2.balanceOf(tokenHolder.address)).to.equal(
              v2StartBalance.sub(unmintAmount).sub(fee)
            )
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(await tbtcV1.balanceOf(tokenHolder.address)).to.equal(
              v1StartBalance.add(unmintAmount)
            )
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(tokenHolder.address, unmintAmount, fee)
          })
        })

        context("when unminting part of TBTC v2 balance", () => {
          const unmintAmount = to1e18(1)

          let fee
          let v1StartBalance
          let v2StartBalance
          let tx

          beforeEach(async () => {
            v1StartBalance = await tbtcV1.balanceOf(tokenHolder.address)
            v2StartBalance = await tbtcV2.balanceOf(tokenHolder.address)
            fee = await vendingMachine.unmintFeeFor(unmintAmount)
            tx = await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
          })

          it("should transfer TBTC v2 fee to the VendingMachine", async () => {
            expect(await tbtcV2.balanceOf(vendingMachine.address)).to.equal(fee)
          })

          it("should burn unminted TBTC v2 tokens", async () => {
            expect(await tbtcV2.balanceOf(tokenHolder.address)).to.equal(
              v2StartBalance.sub(unmintAmount).sub(fee)
            )
            expect(await tbtcV2.totalSupply()).to.equal(
              v2StartBalance.sub(unmintAmount)
            )
          })

          it("should transfer unminted TBTC v1 tokens back to the owner", async () => {
            expect(await tbtcV1.balanceOf(tokenHolder.address)).to.equal(
              v1StartBalance.add(unmintAmount)
            )
          })

          it("should emit the Unminted event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "Unminted")
              .withArgs(tokenHolder.address, unmintAmount, fee)
          })
        })
      })
    })
  })

  describe("withdrawFees", () => {
    const unmintAmount = to1e18(4)
    let unmintFee

    beforeEach(async () => {
      await vendingMachine.connect(tokenHolder).mint(initialBalance)
      await tbtcV2
        .connect(tokenHolder)
        .approve(vendingMachine.address, initialBalance)
      unmintFee = await vendingMachine.unmintFeeFor(unmintAmount)
      await vendingMachine.connect(tokenHolder).unmint(unmintAmount)
    })

    context("when caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .withdrawFees(thirdParty.address, unmintFee)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      let withdrawnFee

      beforeEach(async () => {
        withdrawnFee = unmintFee.sub(1)

        await vendingMachine
          .connect(governance)
          .withdrawFees(thirdParty.address, withdrawnFee)
      })

      it("should withdraw the provided amount of fees", async () => {
        expect(await tbtcV2.balanceOf(thirdParty.address)).is.equal(
          withdrawnFee
        )
      })

      it("should leave the rest of fees in VendingMachine", async () => {
        expect(await tbtcV2.balanceOf(vendingMachine.address)).is.equal(
          unmintFee.sub(withdrawnFee)
        )
      })
    })
  })

  describe("initiateUnmintFeeUpdate", () => {
    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(thirdParty).initiateUnmintFeeUpdate(1)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the contract owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(governance).initiateUnmintFeeUpdate(1)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the update initiator", () => {
      const newUnmintFee = 191111

      let tx

      beforeEach(async () => {
        tx = await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .initiateUnmintFeeUpdate(newUnmintFee)
      })

      it("should not update the unmint fee", async () => {
        expect(await vendingMachine.unmintFee()).to.equal(unmintFee)
      })

      it("should start the update initiation time", async () => {
        expect(
          await vendingMachine.unmintFeeUpdateInitiatedTimestamp()
        ).to.equal(await getBlockTime(tx.blockNumber))
      })

      it("should set the pending new unmint fee", async () => {
        expect(await vendingMachine.newUnmintFee()).to.equal(newUnmintFee)
      })

      it("should start the governance delay timer", async () => {
        expect(await vendingMachine.getRemainingUnmintFeeUpdateTime()).to.equal(
          604800 // 7 days contract governance delay
        )
      })

      it("should emit UnmintFeeUpdateInitiated event", async () => {
        await expect(tx)
          .to.emit(vendingMachine, "UnmintFeeUpdateInitiated")
          .withArgs(newUnmintFee, await getBlockTime(tx.blockNumber))
      })
    })
  })

  describe("finalizeUnmintFeeUpdate", () => {
    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(thirdParty).finalizeUnmintFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the update initiator", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(unmintFeeUpdateInitiator)
            .finalizeUnmintFeeUpdate()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      context("when update process is not initialized", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine.connect(governance).finalizeUnmintFeeUpdate()
          ).to.be.revertedWith("Change not initiated")
        })
      })

      context("when update process is initialized", () => {
        const newUnmintFee = 151511

        beforeEach(async () => {
          await vendingMachine
            .connect(unmintFeeUpdateInitiator)
            .initiateUnmintFeeUpdate(newUnmintFee)
        })

        context("when governance delay has not passed", () => {
          it("should revert", async () => {
            await increaseTime(601200) // +7 days 23 hours
            await expect(
              vendingMachine.connect(governance).finalizeUnmintFeeUpdate()
            ).to.be.revertedWith("Governance delay has not elapsed")
          })
        })

        context("when governance delay passed", () => {
          let tx

          beforeEach(async () => {
            await increaseTime(604800) // +7 days contract governance delay
            tx = await vendingMachine
              .connect(governance)
              .finalizeUnmintFeeUpdate()
          })

          it("should update the unmint fee", async () => {
            expect(await vendingMachine.unmintFee()).to.equal(newUnmintFee)
          })

          it("should emit UnmintFeeUpdated event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "UnmintFeeUpdated")
              .withArgs(newUnmintFee)
          })

          it("should reset the governance delay timer", async () => {
            await expect(
              vendingMachine.getRemainingUnmintFeeUpdateTime()
            ).to.be.revertedWith("Change not initiated")
          })

          it("should reset the pending new unmint fee", async () => {
            expect(await vendingMachine.newUnmintFee()).to.equal(0)
          })

          it("should reset the unmint fee update initiated timestamp", async () => {
            expect(
              await vendingMachine.unmintFeeUpdateInitiatedTimestamp()
            ).to.equal(0)
          })
        })
      })
    })
  })

  describe("initiateVendingMachineUpgrade", () => {
    let newVendingMachine

    beforeEach(async () => {
      const VendingMachine = await ethers.getContractFactory("VendingMachine")
      newVendingMachine = await VendingMachine.deploy(
        tbtcV1.address,
        tbtcV2.address,
        unmintFee
      )
      await newVendingMachine.deployed()
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the contract owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(governance)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the upgrade initiator", () => {
      context("when new vending machine address is zero", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(vendingMachineUpgradeInitiator)
              .initiateVendingMachineUpgrade(ZERO_ADDRESS)
          ).to.be.revertedWith("New VendingMachine cannot be zero address")
        })
      })

      context("when new vending machine address is non-zero", () => {
        let tx

        beforeEach(async () => {
          tx = await vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        })

        it("should not transfer token ownership", async () => {
          expect(await tbtcV2.owner()).is.equal(vendingMachine.address)
        })

        it("should start the update initiation time", async () => {
          expect(
            await vendingMachine.vendingMachineUpgradeInitiatedTimestamp()
          ).to.equal(await getBlockTime(tx.blockNumber))
        })

        it("should set the pending new vending machine address", async () => {
          expect(await vendingMachine.newVendingMachine()).to.equal(
            newVendingMachine.address
          )
        })

        it("should start the governance delay timer", async () => {
          expect(
            await vendingMachine.getRemainingVendingMachineUpgradeTime()
          ).to.equal(
            604800 // 7 days contract governance delay
          )
        })

        it("should emit VendingMachineUpgradeInitiated event", async () => {
          await expect(tx)
            .to.emit(vendingMachine, "VendingMachineUpgradeInitiated")
            .withArgs(
              newVendingMachine.address,
              await getBlockTime(tx.blockNumber)
            )
        })
      })
    })
  })

  describe("finalizeVendingMachineUpgrade", () => {
    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine.connect(thirdParty).finalizeVendingMachineUpgrade()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the upgrade initiator", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .finalizeVendingMachineUpgrade()
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when caller is the owner", () => {
      context("when upgrade process is not initialized", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine.connect(governance).finalizeVendingMachineUpgrade()
          ).to.be.revertedWith("Change not initiated")
        })
      })

      context("when upgrade process is initialized", () => {
        const tbtcV1Amount = to1e18(3)
        let newVendingMachine

        beforeEach(async () => {
          const VendingMachine = await ethers.getContractFactory(
            "VendingMachine"
          )
          newVendingMachine = await VendingMachine.deploy(
            tbtcV1.address,
            tbtcV2.address,
            unmintFee
          )
          await newVendingMachine.deployed()

          await tbtcV1
            .connect(tokenHolder)
            .approve(vendingMachine.address, tbtcV1Amount)
          await vendingMachine.connect(tokenHolder).mint(tbtcV1Amount)

          await vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .initiateVendingMachineUpgrade(newVendingMachine.address)
        })

        context("when governance delay has not passed", () => {
          it("should revert", async () => {
            await increaseTime(601200) // +7days 23 hours
            await expect(
              vendingMachine.connect(governance).finalizeVendingMachineUpgrade()
            ).to.be.revertedWith("Governance delay has not elapsed")
          })
        })

        context("when governance delay passed", () => {
          let tx

          beforeEach(async () => {
            await increaseTime(604800) // +7 days contract governance delay
            tx = await vendingMachine
              .connect(governance)
              .finalizeVendingMachineUpgrade()
          })

          it("should transfer token ownership to the new VendingMachine", async () => {
            expect(await tbtcV2.owner()).to.equal(newVendingMachine.address)
          })

          it("should transfer all TBTC v1 to the new VendingMachine", async () => {
            expect(await tbtcV1.balanceOf(newVendingMachine.address)).to.equal(
              tbtcV1Amount
            )
          })

          it("should emit VendingMachineUpgraded event", async () => {
            await expect(tx)
              .to.emit(vendingMachine, "VendingMachineUpgraded")
              .withArgs(newVendingMachine.address)
          })

          it("should reset the governance delay timer", async () => {
            await expect(
              vendingMachine.getRemainingVendingMachineUpgradeTime()
            ).to.be.revertedWith("Change not initiated")
          })

          it("should reset the pending new vending machine address", async () => {
            expect(await vendingMachine.newVendingMachine()).to.equal(
              ZERO_ADDRESS
            )
          })

          it("should reset the vending machine update initiated timestamp", async () => {
            expect(
              await vendingMachine.vendingMachineUpgradeInitiatedTimestamp()
            ).to.equal(0)
          })
        })
      })
    })
  })

  describe("transferUnmintFeeUpdateInitiatorRole", () => {
    context("when caller is the owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(governance)
            .transferUnmintFeeUpdateInitiatorRole(thirdParty.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .transferUnmintFeeUpdateInitiatorRole(thirdParty.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the update initiator", () => {
      it("should transfer the role", async () => {
        await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .transferUnmintFeeUpdateInitiatorRole(thirdParty.address)
        expect(await vendingMachine.unmintFeeUpdateInitiator()).to.equal(
          thirdParty.address
        )
      })

      context("when new initiator is zero address", () => {
        it("should revert", async () => {
          await expect(
            vendingMachine
              .connect(unmintFeeUpdateInitiator)
              .transferUnmintFeeUpdateInitiatorRole(ZERO_ADDRESS)
          ).to.be.revertedWith("New initiator must not be zero address")
        })
      })
    })
  })

  describe("transferVendingMachineUpgradeInitiatorRole", () => {
    context("when caller is the owner", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(governance)
            .transferVendingMachineUpgradeInitiatorRole(thirdParty.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is a third party", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(thirdParty)
            .transferVendingMachineUpgradeInitiatorRole(thirdParty.address)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when caller is the update initiator", () => {
      it("should transfer the role", async () => {
        await vendingMachine
          .connect(vendingMachineUpgradeInitiator)
          .transferVendingMachineUpgradeInitiatorRole(thirdParty.address)
        expect(await vendingMachine.vendingMachineUpgradeInitiator()).to.equal(
          thirdParty.address
        )
      })
    })

    context("when new initiator is zero address", () => {
      it("should revert", async () => {
        await expect(
          vendingMachine
            .connect(vendingMachineUpgradeInitiator)
            .transferVendingMachineUpgradeInitiatorRole(ZERO_ADDRESS)
        ).to.be.revertedWith("New initiator must not be zero address")
      })
    })
  })

  describe("unmintFeeFor", () => {
    const unmintAmount = to1e18(2)

    context("when unmint fee is non-zero", async () => {
      it("should return a correct portion of the amount to unmint", async () => {
        // 0.001 * 2 = 0.002
        await expect(await vendingMachine.unmintFeeFor(unmintAmount)).to.equal(
          to1ePrecision(2, 15)
        )
      })
    })

    context("when unmint fee is zero", async () => {
      beforeEach(async () => {
        await vendingMachine
          .connect(unmintFeeUpdateInitiator)
          .initiateUnmintFeeUpdate(0)
        await increaseTime(604800) // +7 days contract governance delay
        await vendingMachine.connect(governance).finalizeUnmintFeeUpdate()
      })

      it("should return zero", async () => {
        // 0.001 * 0 = 0
        await expect(await vendingMachine.unmintFeeFor(unmintAmount)).to.equal(
          0
        )
      })
    })
  })
})
