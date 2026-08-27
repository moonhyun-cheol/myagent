MY Agent 설치·실행 안내 (v1.0.0-beta.1)
====================

직원 PC: GitHub 릴리스 v* 의 MYAgent-v*-install.zip 만 사용합니다.
그 zip 루트에 install.bat + app\ 가 있습니다.

git clone / Source code (zip) 은 설치 패키지가 아닙니다.
exe 가 없고, 저장소 루트에 install.bat 도 없습니다. 개발은 npm start.

1. (zip에서) install.bat — 관리자 권한 없이 %LOCALAPPDATA%\Programs\MYAgent 에 설치
   (다른 폴더를 고르면 그 안에 MYAgent 폴더를 만들고 설치합니다. C:\ / Program Files 금지)
2. MYAgent.exe — 앱 실행 (사용자 시작점)

업데이트: 설치된 앱이 켤 때 서명된 델타를 받습니다. 수동이면 UPDATE.bat (delta zip, data/ 보존)
관리자 명령: tools\commands\

명령 전체: rulebook\docs\ops\명령어-모음.md
배포 가이드: rulebook\docs\ops\deploy-guide.md

Node: runtime/node/node.exe 포함 (포함)
