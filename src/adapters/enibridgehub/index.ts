import { BridgeAdapter } from "../../helpers/bridgeAdapter.type";
import { getLogs } from "@defillama/sdk/build/util/logs";
import { ethers } from "ethers";
import { Chain } from "@defillama/sdk/build/general";

const ORBITER_CONTRACT = "0xe530d28960d48708CcF3e62Aa7B42A80bC427Aef";

const SOURCE_CHAINS: Chain[] = [
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "optimism",
  "base",
];

const ENI_CHAIN = "eni" as unknown as Chain;

/**
 * Orbiter BridgeExecuted event
 */
const iface = new ethers.utils.Interface([
  "event BridgeExecuted(address indexed sender,address indexed recipient,address inputToken,address outputToken,uint256 inputAmount,bytes extData)",
]);

const BRIDGE_EXECUTED_TOPIC = iface.getEventTopic("BridgeExecuted");

/**
 * Extract destination chainId from extData
 * Orbiter routing is based ONLY on `c=`
 */
function getDestinationChainId(extDataHex: string): number | null {
  try {
    const decoded = ethers.utils.toUtf8String(extDataHex);
    const match = decoded.match(/(^|[&?])c=(\d+)/);
    return match ? Number(match[2]) : null;
  } catch {
    try {
      const ascii = Buffer.from(extDataHex.replace(/^0x/, ""), "hex").toString();
      const match = ascii.match(/(^|[&?])c=(\d+)/);
      return match ? Number(match[2]) : null;
    } catch {
      return null;
    }
  }
}

function isDestinationENI(extDataHex: string): boolean {
  return getDestinationChainId(extDataHex) === 173;
}

/**
 * Conservative per-chain getLogs chunk sizes
 */
function getChunkSize(chain: Chain): number {
  if (chain === "bsc") return 400;
  if (chain === "polygon") return 1500;
  if (chain === "arbitrum" || chain === "optimism" || chain === "base") return 4000;
  return 3000; // ethereum & others
}

/**
 * Safe chunked getLogs with auto-shrinking
 */
async function getLogsSafe(params: {
  chain: Chain;
  fromBlock: number;
  toBlock: number;
}) {
  const { chain, fromBlock, toBlock } = params;
  const chunkSize = getChunkSize(chain);

  const allLogs: any[] = [];

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    let end = Math.min(start + chunkSize - 1, toBlock);

    while (true) {
      try {
        const logs = await getLogs({
          chain,
          target: ORBITER_CONTRACT,
          fromBlock: start,
          toBlock: end,
          topics: [BRIDGE_EXECUTED_TOPIC],
        });
        allLogs.push(...logs);
        break;
      } catch (e) {
        const range = end - start + 1;
        if (range <= 50) throw e; // give up if too small
        end = start + Math.floor(range / 2);
      }
    }
  }

  return allLogs;
}

/**
 * Inflows: Source chain → ENI
 */
function inflowAdapter(chain: Chain) {
  return async (fromBlock: number, toBlock: number) => {
    const logs = await getLogsSafe({ chain, fromBlock, toBlock });

    const events: any[] = [];

    for (const log of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }

      const { sender, recipient, inputToken, inputAmount, extData } = parsed.args;

      if (!isDestinationENI(extData)) continue;

      events.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        from: sender,
        to: recipient,
        token: inputToken,
        amount: inputAmount,
        isDeposit: true,
      });
    }

    return events;
  };
}

/**
 * Outflows: ENI → Other chains
 */
function outflowAdapter() {
  return async (fromBlock: number, toBlock: number) => {
    const logs = await getLogsSafe({
      chain: ENI_CHAIN,
      fromBlock,
      toBlock,
    });

    const events: any[] = [];

    for (const log of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }

      const { sender, recipient, inputToken, inputAmount, extData } = parsed.args;

      // destination is NOT ENI → outflow
      if (isDestinationENI(extData)) continue;

      events.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        from: sender,
        to: recipient,
        token: inputToken,
        amount: inputAmount,
        isDeposit: false,
      });
    }

    return events;
  };
}

const adapter: BridgeAdapter = {
  ...Object.fromEntries(SOURCE_CHAINS.map((c) => [c, inflowAdapter(c)])),
  eni: outflowAdapter(),
};

export default adapter;