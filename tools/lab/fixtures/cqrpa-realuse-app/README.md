# CQRPA Realuse App

실사용 점검용 미니 앱입니다. **MY Agent 작업 폴더로 이 디렉터리(또는 하네스가 복사한 work tree)를 연결**하면 채팅·터미널·Accept/Reject·@ 컨텍스트를 실전처럼 돌릴 수 있습니다.

## 한 줄로 자동 전 표면 점검

```bash
# 저장소 루트에서
npm run build
npm run lab:realuse
```

리포트: `data/_skill_tool_lab/realuse-full-check-report.{json,md}`

## UI에서 수동으로

1. MY Agent 실행 → 작업 폴더 =
   `tools/lab/fixtures/cqrpa-realuse-app`  
   또는 하네스 작업 사본 `data/_realuse_lab/app`
2. 코드 모드에서 `REALUSE_TASKS.md` 를 `@` 로 첨부하거나 열어 둔 뒤 항목을 하나씩 수행
3. mutate 후 **Accept / Reject 선택·diff / 복원** 확인
4. 하단 Terminal에서 `npm test`, 장명령 Stop / Active jobs 확인
5. Manager → User MCP / 플러그인 패널 스모크

## 로컬 앱 자체

```bash
cd tools/lab/fixtures/cqrpa-realuse-app
npm test
npm start   # PORT or 8765
```
