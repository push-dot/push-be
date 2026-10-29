# AI 서비스를 Hostinger KVM 2에 올리기

대상은 Ubuntu 24.04 VPS (2 vCPU / 8 GB)다. 관리 패널은 없다. `harden.sh`가 서버를 잠그고, GitHub Actions가 `deploy` 사용자로 배포한다. 비밀값은 저장소에 없고 사람이 서버에 입력하지도 않는다. 모두 GitHub Actions 시크릿에서 배포할 때 내려간다. `AI_ORIGIN`이 비어 있으면 게이트웨이는 500 `NOT_CONFIGURED`를 돌려준다. 서비스 바인딩은 없다.

## 사고 요약 (2026-10-21)

- 원인: Dokploy 패널이 `:3000`에 열려 있었고 첫 관리자 계정을 아무도 만들지 않은 상태였다. 봇이 먼저 관리자로 가입했다.
- 피해: 봇이 Dokploy가 쓰던 root SSH 키를 가져가 포트 스캔 웜을 설치했다. Hostinger가 VPS를 정지했다.
- 조치: VPS를 새 Ubuntu 이미지로 다시 설치한다. Dokploy를 없애고 아래 하드닝을 적용한다. 서버에 있던 비밀값은 모두 유출된 것으로 보고 교체한다.

## 하드닝 요약

| 영역 | 적용한 것 | 파일 |
| --- | --- | --- |
| 공개 포트 | 인바운드는 22, 80, 443만 연다. 80/443은 compose 안의 Traefik만 받는다. 컨테이너에서 호스트로 새 연결을 열 수 없다 | `bin/push-firewall` |
| 이그레스 | 호스트와 컨테이너 모두 SMTP(25, 465, 587, 2525), RFC1918·CGNAT·link-local(클라우드 메타데이터)로 나가는 연결을 버린다. 새 TCP 연결은 컨테이너 IP당 초당 20개(버스트 200), 호스트 전체 초당 30개(버스트 300)로 제한한다. 버린 패킷은 `push-fw-` 접두어로 커널 로그에 남는다 | `bin/push-firewall` |
| 방화벽 유지 | `push-firewall.service`가 부팅할 때마다 Docker보다 먼저 규칙을 만든다. `docker.service`는 이 유닛이 성공해야 시작한다 | `harden.sh` |
| 프록시 | Traefik v3, file provider만 쓴다(docker.sock 없음). Let's Encrypt TLS, HSTS 등 보안 헤더, 출처 IP당 초당 50요청(버스트 100) 제한, TLS 1.2 이상 | `traefik/` |
| 컨테이너 | 이미지는 모두 다이제스트로 고정한다. 모두 non-root, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `pids_limit`, 메모리 한도. host 네트워크·docker.sock·privileged 없음. Redis는 비밀번호를 쓰고 내부 네트워크에만 있다 | `compose.yaml` |
| compose 검사 | 렌더한 설정에 docker.sock, `use_api_socket`, privileged, host 네임스페이스·네트워크, 쓰기 가능한 bind, 호스트 경로를 가리키는 볼륨(`driver_opts`), root 사용자(`root:root` 포함), 빌드의 host 네트워크·privileged·entitlements, 다이제스트 없는 이미지, 프록시 외 포트, Dokploy가 있으면 거부한다. CI와 VPS 배포 직전에 모두 돌린다. VPS 사본은 root 소유라 커밋으로 바꿀 수 없다 | `bin/check-compose` |
| SSH | root 로그인과 비밀번호 로그인을 끈다. `deploy`만 들어올 수 있다. 키 파일은 root 소유 `/etc/ssh/authorized_keys/deploy`라서 `deploy` 셸로 키를 추가할 수 없다. CI 키는 `push-deploy` 강제 명령에 묶여 셸을 얻지 못한다. 포워딩을 모두 끄고 지원되는 강한 KEX·암호·MAC만 남긴다 | `harden.sh`, `bin/push-deploy` |
| 무차별 대입 | fail2ban `sshd`(3회 실패 시 1시간, 반복하면 최대 1주), `recidive`. 방화벽에서도 SSH 새 연결을 출처당 분당 6개로 제한한다. 프록시 jail은 두지 않는다. 호출자가 Cloudflare Worker라서 공유 IP를 막으면 서비스가 멈춘다 | `harden.sh` |
| 커널 | `rp_filter`, 리다이렉트 거부, `tcp_syncookies`, `kptr_restrict=2`, `dmesg_restrict`, `ptrace_scope=2`, 비특권 BPF 금지, `/dev/shm` `noexec` 등 | `harden.sh` |
| 감사 | auditd가 `/etc/systemd`, `/etc/cron*`, `/etc/ssh`, `/root/.ssh`, `/home/*/.ssh`, `/usr/local/bin`, `/etc/docker`, 계정 파일, `/tmp`·`/dev/shm` 실행을 기록한다. `ausearch -k push-ssh`처럼 키로 찾는다 | `harden.sh` |
| 업데이트 | unattended-upgrades가 Ubuntu 보안 업데이트와 Docker CE를 매일 설치하고, 필요하면 04:30(UTC)에 재부팅한다 | `harden.sh` |
| 감시 | `push-watchdog.timer`가 5분마다 확인한다. 아래 [경보 대응](#경보-대응)을 본다 | `bin/push-watchdog` |

Docker는 공식 저장소에서 설치한다. `daemon.json`은 `no-new-privileges`, `live-restore`, `icc: false`, `userland-proxy: false`, 주소 풀 `172.30.0.0/16`, `local` 로그 드라이버(20 MB × 5)를 쓴다. snapd, cups, avahi, rpcbind, ModemManager, postfix, exim4 등 쓰지 않는 서비스는 끄고 mask한다.

`deploy`는 `docker` 그룹이라 사실상 root와 같다. 그래서 CI 키는 강제 명령에 묶었고, 관리자 키는 따로 둔다.

## GitHub Actions 시크릿과 변수

배포 잡의 첫 단계가 필수 항목이 비었는지 확인한다. 하나라도 없으면 배포하기 전에 이름을 출력하고 멈춘다. GitHub는 `GITHUB_`로 시작하는 이름을 막아서 GitHub OAuth 앱은 `GH_OAUTH_*`로 넣고, CI가 앱이 읽는 `GITHUB_CLIENT_*`로 바꿔 쓴다.

필수 시크릿:

| 이름 | 쓰는 곳 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Worker 배포와 시크릿 쓰기 |
| `VPS_HOST` | VPS IP 또는 호스트 이름 |
| `VPS_SSH_KEY` | `deploy`용 CI 개인 키(ed25519). 공개 키는 `keys/push-deploy.pub` |
| `DATABASE_URL` | VPS, `push-be-core`, `push-be` |
| `REDIS_PASSWORD` | VPS |
| `AI_SHARED_SECRET` | VPS, `push-be-core`, `push-be` |
| `INTERNAL_API_SECRET` | VPS, `push-be-core`, `push-be` |
| `DISPATCH_SECRET` | VPS, `push-be-core` |
| `ADMIN_TOKEN` | VPS 디스패처 `/admin/*` |
| `TOKEN_ENCRYPTION_KEY` | VPS, `push-be-core`. Google 연동 OAuth 토큰 암호화 키 |
| `OPENROUTER_API_KEY` | VPS |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | VPS, `push-be-core` |
| `GOOGLE_CLIENT_SECRET` | VPS, `push-be-core` |
| `GH_OAUTH_CLIENT_SECRET` | VPS, `push-be-core` (`GITHUB_CLIENT_SECRET`으로 들어간다) |

선택 시크릿(비어 있으면 건너뛴다): `RESEND_API_KEY`(VPS, `push-be-core`), `DISCORD_ALERT_WEBHOOK_URL`, `OPENAI_API_KEY`, `EMBEDDING_API_KEY`, `EXPO_ACCESS_TOKEN`.

필수 변수: `AI_HOST`, `DISPATCH_HOST`, `GOOGLE_CLIENT_ID`, `GH_OAUTH_CLIENT_ID`(`GITHUB_CLIENT_ID`로 들어간다), `STRIPE_PRICE_PRO`, `STRIPE_PRICE_ULTRA`, `VPS_SSH_HOST_KEY`(`harden.sh`가 출력한 `ssh-ed25519 AAAA…`. CI는 이 키만 믿는다. 처음 본 키를 믿지 않는다).

선택 변수: `CORE_ORIGIN`, `QUEUE_BACKEND`, `EMBEDDING_PROVIDER`, `EMBEDDING_API_MODEL`, `RERANK_PROVIDER`, `AI_HARNESS`, `AI_BASE_URL`, `NEON_STORAGE_LIMIT_BYTES`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `AI_WORKER_CONCURRENCY`, `INGEST_WORKER_CONCURRENCY`, `DEPLOY_BRANCH`.

CI가 하는 일:

1. VPS: 저장소 tar를 `/opt/push-be/releases/<sha>`에 풀고, 위 값으로 `/opt/push-be/.env`(0600, `deploy` 소유)를 새로 쓴 뒤 `check-compose`를 통과하면 `docker compose up -d --build`를 실행한다. 값은 로그에 찍지 않는다. 작은따옴표나 줄바꿈이 든 값은 거부한다. 최근 릴리스 3개만 남긴다.
2. Worker: `wrangler secret bulk`로 `push-be`와 `push-be-core`에만 시크릿을 쓴다. 다른 기존 시크릿은 그대로 둔다. OAuth 클라이언트 ID와 Stripe 가격 ID는 비밀이 아니지만 `wrangler deploy`가 지우지 않도록 시크릿으로 넣는다. `push-be-python`은 배포하지 않고 시크릿도 넣지 않는다. `AI_SHARED_SECRET`은 VPS·코어·게이트웨이가 같이 쓴다. 게이트웨이가 Python으로 넘길 때 `x-push-ai-secret`에 넣는다.
3. `https://<AI_HOST>/healthz`와 `https://<DISPATCH_HOST>/healthz`가 200을 줄 때까지 6분 동안 기다린다.

## 새 VPS 준비

1. Hostinger에서 Ubuntu 24.04를 다시 설치한다. root 비밀번호를 길게 정한다. 이 비밀번호는 Hostinger 브라우저 콘솔에서만 쓴다.
2. `AI_HOST`와 `DISPATCH_HOST`의 A 레코드가 이 VPS를 가리키는지 확인한다(sslip.io 이름은 IP에서 바로 나온다).
3. 노트북에서 스크립트와 관리자 공개 키를 올린다.
   ```bash
   scp -r infra/vps root@<VPS_IP>:/root/push-vps
   scp ~/.ssh/id_ed25519.pub root@<VPS_IP>:/root/push-vps/admin.pub
   ```
4. root로 실행한다. CI 공개 키는 기본값 `keys/push-deploy.pub`를 쓴다.
   ```bash
   ssh root@<VPS_IP> bash /root/push-vps/harden.sh --admin-key /root/push-vps/admin.pub
   ```
   다른 CI 키를 쓰려면 `--deploy-key <공개 키 또는 파일>`을 더한다. 플래그는 여러 번 줄 수 있고, `DEPLOY_PUBKEYS`·`ADMIN_PUBKEYS` 환경 변수(줄마다 키 하나)도 받는다. 공개 키만 받는다.
5. 이 root 세션을 닫지 말고 새 터미널에서 `ssh deploy@<VPS_IP>`가 되는지 확인한다. 이제 root SSH와 비밀번호 로그인은 꺼져 있다.
6. 출력된 `SSH host key` 값을 GitHub 변수 `VPS_SSH_HOST_KEY`에 넣는다. `VPS_HOST` 시크릿이 이 IP인지 확인한다.
7. 5번에서 열어 둔 root 세션에서 `rm -rf /root/push-vps`를 실행하고 세션을 닫는다.
8. `main`에 푸시하거나 CI를 다시 실행해 배포한다.
9. 경보 경로를 확인한다. 콘솔에서 `rm /var/lib/push-watchdog/*.base && systemctl start push-watchdog`를 실행하면 Discord(또는 메일)에 `baseline recorded; alerts are armed`가 온다.

`harden.sh`는 다시 실행해도 안전하다. VPS의 `check-compose`와 `push-watchdog`은 root 소유 사본이라 저장소에서 바꿔도 `harden.sh`를 다시 실행해야 반영된다. Docker 저장소 키는 공개된 지문(`9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`)과 다르면 설치를 멈춘다. 실행할 때마다 키 목록을 통째로 바꾸고, 설정 파일을 다시 쓰고, 감시 기준선을 새로 잡는다. root가 필요하므로 Hostinger 콘솔에서 실행한다.

Neon 스키마는 여전히 수동이다. `db/migrations/0028_fk_actions_hot_indexes.sql`까지 적용한다. 0027·0028은 인덱스를 만드는 동안 해당 테이블 쓰기를 잠깐 막으니 한가한 시간에 돌린다. 그다음 업로드 파일을 DB로 옮긴다. 다시 실행해도 안전하다.
```bash
docker compose -p push-ai --env-file /opt/push-be/.env -f /opt/push-be/current/infra/vps/compose.yaml \
  exec ai-worker python scripts/migrate_blobs_to_db.py
```
`services/ai/scripts/seed_local.py`는 `APP_ENV=development`가 아니면 종료한다. 프로덕션에서 실행하지 않는다.

## 교체 런북

| 대상 | 방법 |
| --- | --- |
| 앱 비밀값(`DATABASE_URL`, `AI_SHARED_SECRET`, `INTERNAL_API_SECRET`, `DISPATCH_SECRET`, `ADMIN_TOKEN`, `REDIS_PASSWORD`, API 키, OAuth·Stripe 비밀) | 발급처에서 새 값을 만든다 → GitHub 시크릿을 바꾼다 → 배포를 다시 실행한다. CI가 VPS `.env`와 게이트웨이·코어 Worker를 한 번에 바꾼다. 여러 곳이 같은 값을 쓰는 비밀은 배포하는 몇 분 동안 맞지 않을 수 있다 |
| `DATABASE_URL` | Neon에서 역할 비밀번호를 재설정한다. 이전 값은 그 즉시 막힌다. 바로 위 방법으로 배포한다 |
| `TOKEN_ENCRYPTION_KEY` | 값을 바꾸면 저장된 Google 연동 토큰을 복호화할 수 없다. 재암호화 마이그레이션 없이 값을 바꾸지 않는다 |
| CI 배포 키 | `ssh-keygen -t ed25519 -C push-deploy-<날짜>`로 새 키를 만든다 → `keys/push-deploy.pub`를 바꾼다 → 콘솔에서 `harden.sh --deploy-key <새 .pub> --admin-key …`를 다시 실행한다(이전 키는 지워진다) → `VPS_SSH_KEY` 시크릿을 새 개인 키로 바꾼다 |
| 관리자 키 | `harden.sh`를 새 `--admin-key`로 다시 실행한다. 빼면 그 키는 지워진다 |
| VPS 재설치 | 새 VPS 준비를 처음부터 한다. 호스트 키가 바뀌므로 `VPS_SSH_HOST_KEY`도 바꾼다 |

## 경보 대응

`push-watchdog`가 5분마다 확인하는 것:

| 경보 | 뜻 |
| --- | --- |
| `units`, `cron` | systemd 유닛 또는 cron 항목이 생기거나 바뀌었다. `pkg …` 줄은 패키지 업데이트일 수 있다 |
| `access` | `authorized_keys`, sshd·sudo·PAM 설정, `/etc/ld.so.preload`가 바뀌었다 |
| `binaries` | `/usr/local/bin`, `/usr/local/sbin`, `/usr/local/lib/push`, `/etc/docker`가 바뀌었다 |
| `users` | 계정이나 `root`·`sudo`·`adm`·`docker` 그룹 구성원이 바뀌었다 |
| `listeners` | 호스트에 새 리스닝 소켓이 생겼다 |
| `containers` | 처음 보는 컨테이너가 떴거나, 컨테이너의 이미지·privileged·호스트 네임스페이스·추가 권한이 바뀌었다. 이미지 다이제스트를 올린 배포 직후 한 번은 정상이다 |
| `procs` | `/tmp`, `/var/tmp`, `/dev/shm`, `/root`, `/home`에서 실행 중인 프로세스나 masscan·xmrig 같은 이름이 있다 |
| `firewall` | 방화벽이 나가는 연결을 버렸다. `*-LIMIT`은 연결 속도 초과(스캐너), `*-DROP`은 SMTP·사설망 시도다. `PUSH chains are missing`은 규칙이 사라졌다는 뜻이다 |

알림은 Discord 웹훅으로 먼저 보내고, 실패하면 Resend로 `ALERT_EMAIL_TO`에 메일을 보낸다. 항상 저널(`journalctl -t push-watchdog`)에도 남는다. 같은 변화는 한 번만 알린다.

1. 기대한 변화인지 본다. `harden.sh`를 다시 실행했거나 패키지 업데이트(`pkg` 줄, 재부팅)라면 끝이다.
2. 자세히 본다(`deploy` 셸에서 가능하다).
   ```bash
   journalctl -t push-watchdog -n 50
   journalctl -k -g push-fw --since -1h        # SRC=가 출발지, DPT=가 목적지 포트
   docker ps --format '{{.Names}} {{.Networks}}'
   docker network inspect push-ai_edge push-ai_push-internal --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
   ```
   `ausearch -k push-ssh -i`처럼 감사 로그는 콘솔에서 root로 본다.
3. 컨테이너 하나가 원인이면 그 컨테이너를 멈춘다. `docker stop push-ai-<서비스>-1`
4. 알 수 없는 유닛, cron, 키, 사용자, 프로세스면 침해로 본다. 정리하려 하지 않는다.
   1. Hostinger 패널에서 VPS를 멈추거나 패널 방화벽으로 22번만 남긴다.
   2. 위 교체 런북대로 모든 비밀값과 CI 키를 바꾼다.
   3. VPS를 다시 설치하고 새 VPS 준비를 처음부터 한다.

## 컨테이너와 메모리

KVM 2는 8,192 MB다. 관리 패널이 없어서 이 compose의 한도 합계 5,184 MB를 빼도 OS와 Docker에 약 3 GB가 남는다. tmpfs도 각 컨테이너 한도에 포함된다.

| 서비스 | 하는 일 | 한도 |
| --- | --- | --- |
| `proxy` | Traefik. TLS를 끝내고 `AI_HOST` → `ai-worker:8080`, `DISPATCH_HOST` → `dispatcher:8091`로 보낸다. 80/443을 여는 유일한 서비스다 | 128 MB |
| `ai-worker` | `q:chat:priority` → `q:chat` → `q:document` 순서로 읽는다. 채팅, 기업 AI, 서류 생성, 공고 적합도를 처리한다. `SERVE_API=1`이라 core로 아직 옮기지 않은 Python 경로(임시 `ai-api`)도 같은 프로세스에서 받는다. 하네스 산출물은 `ai-data` 볼륨의 `/data/resume`에 남는다 | 1,280 MB |
| `ingest-worker` | `q:ingest`. 업로드, 링크, GitHub, 공고를 잘라 `rag_nodes`에 색인한다 | 512 MB |
| `dispatcher` | outbox를 Redis Streams로 넘기고, 지연 큐를 승격하고, 멈춘 작업을 되돌린다. `/internal/kick`, `/admin/*`, 경보를 맡는다. 유지보수 루프가 만료된 `rate_limits`와 삭제 요청 후 30일이 지난 계정을 지운다 | 128 MB |
| `notify-worker` | `q:notify`. 알림 행을 쓰고 Expo 푸시를 보낸다 | 128 MB |
| `redis` | 큐, 속도 제한, 락, 임베딩 캐시. 외부 포트가 없고 `push-internal` 네트워크에서만 열린다. AOF `everysec`과 RDB 스냅샷을 쓴다. `maxmemory 128mb`, `volatile-lru`라서 TTL이 있는 임베딩 캐시만 밀려나고 큐 데이터는 남는다 | 192 MB |
| `embed` | TEI `BAAI/bge-m3` (1024차원). 가중치만 약 2.3 GB라서 `--max-batch-tokens 2048`, `--max-concurrent-requests 8`로 활성 메모리를 줄였다 | 2,816 MB |
| `volume-init` | 배포할 때 한 번 돌고 끝난다. `traefik-acme`, `tei-models` 볼륨의 최상위 디렉터리 소유자를 non-root 사용자로 바꾼다. `CHOWN` 권한 하나만 있고 네트워크가 없다 | — |
| 합계 | | 5,184 MB |

- `rerank`(TEI `bge-reranker-v2-m3`)는 기본으로 띄우지 않는다. 이 모델도 가중치가 약 2.3 GB다. 재정렬은 `RERANK_PROVIDER=similarity`(기본값)로 임베딩 코사인 유사도를 쓴다. 쓰려면 `EMBEDDING_PROVIDER=api`로 바꿔 `embed`를 멈추거나 VPS를 올린 뒤 `--profile rerank`로 `rerank`를 띄우고 `RERANK_PROVIDER=tei`를 넣는다.
- `embed`가 메모리 부족으로 재시작되면 `EMBEDDING_PROVIDER=api`로 바꾸고 `embed`를 멈춘다. 그러면 합계가 2,368 MB로 줄어든다.

배포한 뒤 `docker stats`로 실제 사용량을 확인한다.

## 전환과 되돌리기

| 변수 | 값 | 되돌리기 |
| --- | --- | --- |
| `QUEUE_BACKEND` | `redis` | `postgres`로 바꾸면 `ai-worker`의 API 프로세스가 다시 `chat_jobs`를 직접 처리한다. core에도 같은 값을 넣는다 |
| `EMBEDDING_PROVIDER` | `tei` | `api`로 바꾸면 OpenAI 호환 `/embeddings`(1024차원)를 쓴다 |
| `RERANK_PROVIDER` | `similarity` | `tei`는 `rerank` 프로필을 띄웠을 때만 쓴다 |

기존 업로드를 `rag_nodes`에 다시 색인하려면 `q:ingest`에 `{"reindex": true}`를 넣는다. 그다음 `run_eval.py`로 검색 품질을 본다.

## 처리량 측정

`embed`가 뜬 뒤 컨테이너 안에서 측정한다. 업로드 1건(청크 60개)을 30초 안에 색인하는 것이 목표다.

```bash
docker compose -p push-ai --env-file /opt/push-be/.env -f /opt/push-be/current/infra/vps/compose.yaml exec ingest-worker python scripts/bench_embed.py
docker compose -p push-ai --env-file /opt/push-be/.env -f /opt/push-be/current/infra/vps/compose.yaml exec ingest-worker python eval/rag/run_eval.py --engine llamaindex
```

`meetsTarget`이 `false`면 VPS를 올리거나 `EMBEDDING_PROVIDER=api`를 기본으로 둔다.

## 관리 엔드포인트

디스패처 호스트에서 `Authorization: Bearer <ADMIN_TOKEN>`으로 부른다.

| 요청 | 결과 |
| --- | --- |
| `GET /admin/queue/stats` | 스트림별 `{length, oldestAgeSec, pending}`, 작업 종류별 24시간 `{waitP50, waitP95, runP50, runP95, failRate, dead}`, `neon:{dbSizeBytes, ragNodes}` |
| `GET /admin/jobs?status=DEAD` | 작업 목록 (최대 200건) |
| `POST /admin/jobs/{id}/retry` | `DEAD`·`FAILED` 작업을 `QUEUED`로 되돌리고 크레딧을 다시 예약한다 |
| `POST /admin/jobs/{id}/cancel` | `QUEUED`·`RETRY`·`RUNNING` 작업을 취소하고 예약을 해제한다 |
| `POST /admin/queues/{name}/pause`, `/resume` | 워커가 그 스트림을 읽지 않게 하거나 다시 읽게 한다 |

## 경보

디스패처는 1분마다 Redis만 보고, 15분 스윕 때 DB를 본다. Neon 무료 플랜이 쉬는 상태로 들어갈 수 있도록 1분 주기로는 DB에 연결하지 않는다.

| 조건 | 기준 | 주기 |
| --- | --- | --- |
| `queue_wait` | 가장 오래 기다린 메시지가 120초를 넘는다 | 1분 |
| `dead_recent` | 최근 10분 안에 `q:dead`에 들어온 작업이 있다 | 1분 |
| `heartbeat_lost` | 하트비트가 끊겨 `RETRY`로 되돌린 작업이 있다 | 15분 |
| `db_size` | DB 크기가 `NEON_STORAGE_LIMIT_BYTES`의 80% 이상이다 | 15분 |

같은 조건은 30분에 한 번만 보낸다. 조건이 풀리면 `[복구]`를 보낸다. Discord 웹훅(`DISCORD_ALERT_WEBHOOK_URL`)으로 보내고, 실패하면 Resend(`RESEND_API_KEY`)로 `ALERT_EMAIL_TO`에 메일을 보낸다. 임베딩 처리량 경보는 아직 없다. 처리량은 `bench_embed.py`로 배포 전에 잰다.

코드 밖에서 준비할 것:

1. Discord에 `#push-alerts` 채널과 웹훅을 만들어 `DISCORD_ALERT_WEBHOOK_URL`에 넣는다.
2. Better Stack 무료 업타임 체크 2개(게이트웨이 `/healthz`, `https://<AI_HOST>/healthz`)를 만들고 같은 Discord 채널에 연결한다.

## 보관 정리

15분 스윕마다 끝난 지 30일이 지난 `ai_jobs`(`DONE`, `FAILED`, `DEAD`, `CANCELLED`)를 지운다. `outbox`, `chat_events`, `credit_reservations`는 함께 지워지고, `ai_usage.job_id`는 `NULL`이 된다. 비용 기록인 `ai_usage` 행은 남는다.

## 로그와 추적

워커는 작업이 끝날 때마다 JSON 한 줄을 남긴다.

```json
{"jobId": "…", "type": "chat", "step": "done", "docIds": null, "promptHash": null, "tokensIn": null, "tokensOut": null, "latencyMs": 812}
```

`step`은 `done`, `failed`, `delayed`, `cancelled` 중 하나다. 핸들러가 `ctx.log`에 `docIds`, `promptHash`, `tokensIn`, `tokensOut`을 채우면 그 값이 들어간다.

추적 수집기는 아직 붙이지 않는다. 나중에 OpenTelemetry를 붙일 때 쓸 span 이름은 다음과 같다.

| span | 범위 |
| --- | --- |
| `queue.job/<type>` | 워커가 작업 하나를 처리하는 전체 구간 |
| `rag.ingest` | 읽기 → 자르기 → 임베딩 → 저장 |
| `rag.search` | 밀집 검색 + 키워드 검색 + 재정렬 |
| `llm.call` | 모델 호출 한 번 |

## 게이트웨이와 core

Worker 시크릿은 CI가 GitHub에서 쓴다(위 [GitHub Actions 시크릿과 변수](#github-actions-시크릿과-변수)). `wrangler deploy`는 plain vars를 `wrangler.jsonc`로 바꾸므로 `AI_ORIGIN`은 배포 `--var`로 넣는다. 값은 `https://<AI_HOST>`다. 끝 슬래시는 없다. `AI_HOST`가 비어 있으면 값은 `https://`가 된다. 대시보드에만 넣지 않는다. 오리진이 비어 있으면 AI 경로는 500 `NOT_CONFIGURED`다.

`push-be-core`의 `QUEUE_BACKEND`와 `DISPATCH_ORIGIN`은 `wrangler.jsonc`에 있다. `postgres`로 되돌리면 코어도 같은 `AI_ORIGIN`이 필요하다. 비어 있으면 채팅 잡 삽입 뒤에 500 `NOT_CONFIGURED`다. `DISPATCH_HOST`를 바꾸면 `DISPATCH_ORIGIN`도 같이 바꾼다.

Google OAuth 클라이언트의 승인된 리디렉션 URI에 `https://<게이트웨이 호스트>/api/v1/integrations/google/callback`을 추가한다. 이 경로는 이제 core가 받고, 요청이 들어온 게이트웨이 호스트로 콜백 주소를 만든다.

core는 작업을 넣고 커밋한 뒤 `DISPATCH_ORIGIN/internal/kick`을 부른다. 이 호출이 실패해도 작업은 `outbox`에 남고, 다음 15분 스윕에서 처리된다.
