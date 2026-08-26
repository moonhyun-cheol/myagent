# RC-006 manual acceptance

자동 증거(`verify-in-app-browser-path`)는 **호출 경로**만 확인합니다.
아래는 **사용자 클릭** 증거입니다.

## Steps

1. `npm run build` 후 `START.bat` 실행
2. 채팅에 `https://example.com/` 링크가 포함된 메시지 열기
3. 링크 클릭

## Pass

- [ ] 오른쪽 **인앱 브라우저** 패널이 보인다
- [ ] 주소창에 정규화된 URL이 표시된다
- [ ] 채팅/워크스페이스가 그대로 유지된다

## Fail cases

- `file:` 또는 잘못된 scheme → 패널이 열리지 않고 in-app 거절 메시지

## After pass

- RC-006 `verification_status`를 `PASS`로 올리고 desktop harness 증거를 `rulebook/reports/`에 기록
