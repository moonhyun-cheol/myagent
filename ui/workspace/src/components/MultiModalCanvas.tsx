import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';
import { ASSET_MIME, bootstrapCanvasEdges, useWorkspaceStore } from '../store/workspaceStore';
import { AssetCardNode } from './AssetCardNode';

const nodeTypes: NodeTypes = {
  assetCard: AssetCardNode,
};

export function MultiModalCanvas() {
  const nodes = useWorkspaceStore((s) => s.canvasNodes);
  const edges = useWorkspaceStore((s) => s.canvasEdges);
  const setCanvasNodes = useWorkspaceStore((s) => s.setCanvasNodes);
  const setCanvasEdges = useWorkspaceStore((s) => s.setCanvasEdges);
  const placeAssetOnCanvas = useWorkspaceStore((s) => s.placeAssetOnCanvas);

  const fitted = useRef(false);

  useEffect(() => {
    bootstrapCanvasEdges();
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const current = useWorkspaceStore.getState().canvasNodes;
      setCanvasNodes(applyNodeChanges(changes, current));
    },
    [setCanvasNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const current = useWorkspaceStore.getState().canvasEdges;
      setCanvasEdges(applyEdgeChanges(changes, current));
    },
    [setCanvasEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const current = useWorkspaceStore.getState().canvasEdges;
      setCanvasEdges(
        addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: '#0f8f83', strokeWidth: 1.5 },
          },
          current,
        ),
      );
    },
    [setCanvasEdges],
  );

  return (
    <div
      className="relative h-full w-full"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const assetId = e.dataTransfer.getData(ASSET_MIME);
        if (!assetId) return;
        const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
        placeAssetOnCanvas(assetId, {
          x: e.clientX - bounds.left - 130,
          y: e.clientY - bounds.top - 40,
        });
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        onInit={(instance) => {
          if (!fitted.current) {
            fitted.current = true;
            instance.fitView({ padding: 0.2 });
          }
        }}
        proOptions={{ hideAttribution: true }}
        className="bg-ink"
        deleteKeyCode={null}
      >
        <Background gap={28} size={1} color="#b7c0bc" />
        <Controls className="!border-line !bg-panel !shadow-none [&>button]:!border-line [&>button]:!bg-panel-2 [&>button]:!fill-text" />
        <MiniMap
          className="!border-line !bg-panel"
          maskColor="rgba(12,14,18,0.7)"
          nodeColor="#0f8f83"
        />
      </ReactFlow>

      <div className="pointer-events-none absolute left-4 top-4 rounded-lg border border-line/80 bg-panel/90 px-3 py-2 text-xs text-muted backdrop-blur">
        이미지와 워크플로 전용 · 일반 코드는 에디터에서 열립니다
      </div>
    </div>
  );
}
