import {
  assert,
  asyncMap,
  EventType,
  extractIsomorphicInfo,
  RpcError,
  ScriptMode,
  TxAssetCellData,
  TxAssetCellDetail,
} from "@app/commons";
import { ccc } from "@ckb-ccc/shell";
import { Controller, Get, Param } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { AssetService } from "./asset.service";

@Controller()
export class AssetController {
  constructor(private readonly service: AssetService) {}

  async extractCellAssetFromCell(
    cell: ccc.Cell,
    index: number,
    eventType: EventType,
  ): Promise<TxAssetCellDetail> {
    const scriptMode = await this.service.scriptMode(cell.cellOutput.lock);
    const isomorphicInfo =
      scriptMode === ScriptMode.Rgbpp
        ? extractIsomorphicInfo(cell.cellOutput.lock)
        : undefined;
    const cellAsset: TxAssetCellDetail = {
      index,
      capacity: cell.cellOutput.capacity,
      eventType,
      address: await this.service.scriptToAddress(cell.cellOutput.lock),
      typeScriptType: scriptMode,
      isomorphicBtcTx: isomorphicInfo?.txHash
        ? ccc.hexFrom(isomorphicInfo.txHash)
        : undefined,
      isomorphicBtcTxVout: isomorphicInfo?.index
        ? Number(isomorphicInfo.index)
        : undefined,
    };

    const token = await this.service.getTokenFromCell(cell);
    if (token) {
      const { tokenInfo, balance } = token;
      cellAsset.tokenData = {
        tokenId: ccc.hexFrom(tokenInfo.hash),
        name: tokenInfo.name ?? undefined,
        symbol: tokenInfo.symbol ?? undefined,
        decimal: tokenInfo.decimals ?? undefined,
        amount: balance,
      };
    }

    const cluster = await this.service.getClusterInfoFromCell(cell);
    if (cluster) {
      cellAsset.nftData = {
        clusterId: ccc.hexFrom(cluster.clusterId),
        clusterName: cluster.name,
        clusterDescription: cluster.description,
      };
    }

    const spore = await this.service.getSporeFromCell(cell);
    if (spore) {
      cellAsset.nftData = {
        tokenId: ccc.hexFrom(spore.sporeId),
        clusterId: spore.clusterId ? ccc.hexFrom(spore.clusterId) : undefined,
        content: spore.content,
        contentType: spore.contentType,
      };
    }

    return cellAsset;
  }

  async extractTxAssetFromTx(
    tx: ccc.Transaction,
    blockHash?: ccc.Hex,
    blockHeight?: ccc.Num,
  ): Promise<TxAssetCellData> {
    const txAssetData: TxAssetCellData = {
      txId: tx.hash(),
      blockHash,
      blockHeight,
      inputs: [],
      outputs: [],
    };

    const tokenGroups: Record<
      ccc.Hex,
      {
        input: {
          totalBalance: ccc.Num;
          indices: Array<number>;
        };
        output: {
          totalBalance: ccc.Num;
          indices: Array<number>;
        };
      }
    > = {};

    const inputCells = await this.service.extractCellsFromTxInputs(tx);
    for (const [index, input] of inputCells.entries()) {
      const cellAsset = await this.extractCellAssetFromCell(
        input.cell,
        index,
        EventType.Burn,
      );
      if (cellAsset.tokenData) {
        const tokenId = cellAsset.tokenData.tokenId;
        if (tokenGroups[tokenId]) {
          tokenGroups[tokenId].input.totalBalance += cellAsset.tokenData.amount;
          tokenGroups[tokenId].input.indices.push(index);
        } else {
          tokenGroups[tokenId] = {
            input: {
              totalBalance: cellAsset.tokenData.amount,
              indices: [index],
            },
            output: {
              totalBalance: ccc.numFrom(0),
              indices: [],
            },
          };
        }
      }
      txAssetData.inputs.push(cellAsset);
    }

    const outputCells = await this.service.extractCellsFromTxOutputs(tx);
    for (const [index, output] of outputCells.entries()) {
      const cellAsset = await this.extractCellAssetFromCell(
        output.cell,
        index,
        EventType.Mint,
      );
      if (cellAsset.nftData) {
        const nftIndex = txAssetData.inputs.findIndex(
          (input) =>
            input.nftData?.tokenId === cellAsset.nftData?.tokenId ||
            input.nftData?.clusterId === cellAsset.nftData?.clusterId,
        );
        if (nftIndex >= 0) {
          txAssetData.inputs[nftIndex].eventType = EventType.Transfer;
          cellAsset.eventType = EventType.Transfer;
        }
      }
      if (cellAsset.tokenData) {
        const tokenId = cellAsset.tokenData.tokenId;
        if (tokenGroups[tokenId]) {
          tokenGroups[tokenId].output.totalBalance +=
            cellAsset.tokenData.amount;
          tokenGroups[tokenId].output.indices.push(index);
        } else {
          tokenGroups[tokenId] = {
            input: {
              totalBalance: ccc.numFrom(0),
              indices: [],
            },
            output: {
              totalBalance: cellAsset.tokenData.amount,
              indices: [index],
            },
          };
        }
      }
      txAssetData.outputs.push(cellAsset);
    }

    for (const group of Object.values(tokenGroups)) {
      if (group.input.totalBalance === 0n || group.output.totalBalance === 0n) {
        continue;
      }
      if (group.input.totalBalance > group.output.totalBalance) {
        group.input.indices.forEach(
          (index) =>
            (txAssetData.inputs[index].eventType = EventType.BurnAndTransfer),
        );
        group.output.indices.forEach(
          (index) =>
            (txAssetData.outputs[index].eventType = EventType.BurnAndTransfer),
        );
        continue;
      }
      if (group.input.totalBalance === group.output.totalBalance) {
        group.input.indices.forEach(
          (index) => (txAssetData.inputs[index].eventType = EventType.Transfer),
        );
        group.output.indices.forEach(
          (index) =>
            (txAssetData.outputs[index].eventType = EventType.Transfer),
        );
        continue;
      }
      if (group.input.totalBalance < group.output.totalBalance) {
        group.input.indices.forEach(
          (index) =>
            (txAssetData.inputs[index].eventType = EventType.MintAndTransfer),
        );
        group.output.indices.forEach(
          (index) =>
            (txAssetData.outputs[index].eventType = EventType.MintAndTransfer),
        );
        continue;
      }
    }

    return txAssetData;
  }

  @ApiOkResponse({
    type: TxAssetCellData,
    description:
      "Query a list of assets in the cell from a transaction by TxHash",
  })
  @Get("/queryTxAssetCellDataByTxHash")
  async queryTxAssetCellDataByTxHash(
    @Param("txHash") txHash: string,
  ): Promise<TxAssetCellData> {
    const { tx, blockHash, blockNumber } = assert(
      await this.service.getTransactionWithBlockByTxHash(txHash),
      RpcError.TxNotFound,
    );
    return await this.extractTxAssetFromTx(tx, blockHash, blockNumber);
  }

  @ApiOkResponse({
    type: TxAssetCellData,
    description: "Query a list of assets in the cell from a block by BlockHash",
  })
  @Get("/queryTxAssetCellDataListByBlockHash")
  async queryTxAssetCellDataListByBlockHash(
    @Param("blockHash") blockHash: string,
  ): Promise<TxAssetCellData[]> {
    const block = assert(
      await this.service.getBlockByBlockHash(blockHash),
      RpcError.BlockNotFound,
    );
    const txAssetCellDataList: TxAssetCellData[] = [];
    await asyncMap(block.transactions, async (tx) => {
      const txAssetCellData = await this.extractTxAssetFromTx(
        tx,
        block.header.hash,
        block.header.number,
      );
      txAssetCellDataList.push(txAssetCellData);
    });
    return txAssetCellDataList;
  }
}
