# 設定 TURN(讓跨網路通話有聲音)

當通話雙方在不同網路(例如家人用家用寬頻或手機 4G/5G),瀏覽器之間的
**P2P 語音常常穿不過 NAT**,結果就是「看得到在線、但沒聲音」。TURN 是一台
**中繼伺服器**:直連不通時,幫兩邊把聲音轉一手。設定好之後,browser-ptt 會在
需要時**自動**使用它,不必改任何程式碼。

> 只要跨網路,就需要 TURN。同一個區網內測試不需要(那時是本機直連)。

---

## 方式 A:用免費託管 TURN(最快,推薦)

適合先讓家人能通話,十分鐘搞定。以 **metered.ca** 為例(Cloudflare、Twilio 等
概念相同):

1. 到 https://www.metered.ca 註冊免費帳號(免費額度足夠家用)。
2. 建一個 app,拿到它的 **API Key** 與 credentials 端點,長這樣:

   ```
   https://<你的app>.metered.live/api/v1/turn/credentials?apiKey=<你的APIKEY>
   ```

   metered 給的是**動態(會過期)帳密**,所以我們讓伺服器在**登入時自動去抓最新的**,
   而不是把帳密寫死。

3. 用這個端點啟動 browser-ptt(把整個網址放進 `TURN_CREDENTIALS_URL`):

   ```bash
   TURN_CREDENTIALS_URL="https://你的app.metered.live/api/v1/turn/credentials?apiKey=你的APIKEY" \
   npm start
   ```

   > 這把 API Key 是機密。放在 `.env`(已被 git 忽略)或命令列即可,**不要 commit**。
   > 伺服器會快取約 30 分鐘,不會每次登入都打 API。

4. 重開你的 tunnel(指向同一個 port),把網址再傳給家人。
5. **雙方都要重新整理 / 重新登入** — TURN 設定是在「登入時」下發的,舊分頁不生效。

> 若你的供應商給的是**靜態帳密**(或你自架 coturn),則改用
> `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL`(見方式 B 或 `.env.example`)。

---

## 先驗證 TURN 是否有效(不用麻煩家人)

在動員家人之前,先用官方測試頁確認你的 TURN 帳密會產生 **relay** 候選:

1. 開 https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
2. 移除預設的 STUN,新增你的 TURN:
   - **STUN or TURN URI**:`turn:你的HOST:443?transport=tcp`
   - 填入 **username** 與 **credential**
3. 按 **Gather candidates**。
4. 看結果:出現 **`Component ... typ relay`** 就代表 TURN 正常。若只有 `host` /
   `srflx` 而沒有 `relay`,表示帳密或網址有問題。

---

## 在 browser-ptt 裡確認有沒有走 TURN

- 通話時打開電腦 Chrome 的 `chrome://webrtc-internals`,在該連線裡找
  `selectedCandidatePair`;若 candidate type 是 **relay**,就是正在用 TURN。
- 若語音仍連不上,畫面會顯示「⚠️ 語音無法連線…可能需要 TURN」的提示。

---

## 方式 B:自架 coturn(要一台有公網 IP 的 VPS,最穩、可控)

適合要長期、穩定服務的情況。以下用 Docker 最省事。

### 1. `turnserver.conf`

```conf
# 把 YOUR_PUBLIC_IP 換成 VPS 的公網 IP;有網域可另設 realm
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=YOUR_PUBLIC_IP
realm=ptt.example.com
server-name=ptt.example.com

# 長期帳密(demo 用;正式建議改用 use-auth-secret 動態帳密)
lt-cred-mech
user=pttuser:pttpassword

# 建議限制中繼埠範圍,並在防火牆/安全群組一併開放
min-port=49152
max-port=65535

fingerprint
no-multicast-peers
# 正式環境放上憑證(可用 Let's Encrypt):
# cert=/etc/coturn/fullchain.pem
# pkey=/etc/coturn/privkey.pem
```

### 2. `docker-compose.yml`

```yaml
services:
  coturn:
    image: coturn/coturn:latest
    network_mode: host          # TURN 需要大量 UDP 埠,host 網路最單純
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
    restart: unless-stopped
```

### 3. 啟動與防火牆

```bash
docker compose up -d
```

在 VPS 防火牆 / 雲端安全群組開放:
- `3478/udp`、`3478/tcp`(STUN/TURN)
- `5349/tcp`(TURN over TLS)
- `49152-65535/udp`(中繼埠範圍)

### 4. 讓 browser-ptt 使用它

```bash
TURN_URL="turn:YOUR_PUBLIC_IP:3478,turn:YOUR_PUBLIC_IP:3478?transport=tcp,turns:YOUR_PUBLIC_IP:5349?transport=tcp" \
TURN_USERNAME="pttuser" \
TURN_CREDENTIAL="pttpassword" \
npm start
```

---

## 常見問題

- **設了 TURN 還是沒聲音?** 先跑上面的 Trickle ICE 測試確認能拿到 `relay`。
  拿不到就是帳密/網址/防火牆的問題,而不是 browser-ptt 的問題。
- **一定要 `turns:`(443)嗎?** 強烈建議。很多公司/公共 Wi-Fi 只放行 443,
  只有 `turn:3478` 會被擋。
- **會很耗流量嗎?** 只有「直連失敗」的通話才會走 TURN 中繼;能直連的仍是 P2P。
  半雙工(同時只有一人說話)也讓流量維持很低。
