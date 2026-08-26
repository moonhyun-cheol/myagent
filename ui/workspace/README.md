# MY Agent Workspace

React + Vite + Tailwind 기반 MY Agent 단일 제품 UI입니다.
MY Agent API(`:10200`)의 실제 세션·모델·스킬·파일 데이터를 사용합니다.

## 실행

```bash
# 리포 루트 — 개발 (Vite :5174, API 프록시 :10200)
npm run workspace:dev

# 프로덕션 — MY Agent 데스크톱 호스트가 이 UI를 연다 (:10200 /)
# 빌드: npm run build  (workspace dist 포함)
```

브라우저 개발: http://localhost:5174  
앱 기본: http://127.0.0.1:10200/

## 구성

- `MainWorkspaceContainer` — 에디터 / 캔버스 / 미디어 전환 + 3열 레이아웃
- `MultiModalCanvas` — React Flow 무한 캔버스
- `ChatPane` — 텍스트·코드·이미지 모드 AI 입력
- `AssetGallery` / `AssetExplorer` — 자산 히스토리 · 파일 트리 · DnD
