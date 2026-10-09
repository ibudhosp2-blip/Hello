# Uptime Watch

ตัวตรวจ uptime ที่รันตลอด 24 ชม. ตรวจเว็บ, เครื่อง, พอร์ต และฐานข้อมูล SQL (MySQL/MariaDB, PostgreSQL, SQL Server) ตามรอบเวลา บันทึกผลลง SQLite และแสดงบนหน้า dashboard พร้อมแจ้งเตือนเมื่อล่มและเมื่อกลับมา

## ping ได้ ไม่ได้แปลว่าระบบทำงาน

ping ตอบแค่ว่า "เครื่องยังเปิดอยู่" แต่บริการบนเครื่องอาจตายไปแล้ว Uptime Watch จึงตรวจทีละชั้น และบอกว่าล้มที่ชั้นไหน

| ชั้น | ตรวจอะไร | ถ้าล้มตรงนี้ แปลว่า |
|---|---|---|
| DNS | หาชื่อโฮสต์เจอไหม | ชื่อเครื่องผิด หรือ DNS มีปัญหา |
| พอร์ต (TCP) | พอร์ต เช่น 3306 รับการเชื่อมต่อไหม | เครื่องดับ, ไฟร์วอลล์บล็อก หรือบริการ SQL ไม่ได้รันอยู่ |
| เข้าสู่ระบบ | ล็อกอินด้วยผู้ใช้ monitor ได้ไหม | รหัสผ่านผิด, ผู้ใช้ถูกล็อก, ฐานข้อมูลไม่มีอยู่, connection เต็ม |
| รันคำสั่ง SQL | query ทำงานเสร็จในเวลาไหม | ตารางเสีย, ล็อกค้าง, ไม่มีสิทธิ์, query ช้าจน timeout |
| ผลลัพธ์ | ค่าที่ได้อยู่ในเกณฑ์ไหม | ฐานข้อมูลเปิดอยู่แต่ข้อมูลผิดปกติ เช่น ไม่มีออเดอร์ใหม่ หรือ replica ตามไม่ทัน |

ถ้าเวลาตอบเกิน `slowMs` จะแสดงเป็น **ทำงานแต่ช้า** (ไม่นับว่าล่ม)

### เลือก query ให้ตรงกับที่ต้องการรู้

- `SELECT 1` บอกว่าเซิร์ฟเวอร์รับคำสั่งได้ ใช้เป็นขั้นต่ำ
- `SELECT COUNT(*) AS n FROM orders WHERE created_at > NOW() - INTERVAL 1 DAY` กับ `"expectValue": {"column": "n", "min": 1}` บอกว่าแอปยังเขียนข้อมูลเข้ามาจริง
- ความล่าช้าของ replica เช่น `SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), NOW()) AS lag_s FROM app.orders` กับ `"max": 120`
- PostgreSQL: `SELECT count(*) AS n FROM pg_stat_activity` กับ `"max": 180` เพื่อจับ connection ใกล้เต็ม

ใช้ query ที่เบาและมี index เพราะจะรันทุกรอบ

## เริ่มใช้งาน

ควรรันบน **เครื่องอื่น** ที่ไม่ใช่เครื่องที่ถูกตรวจ ถ้ารันบนเครื่องเดียวกัน พอเครื่องดับตัวตรวจก็ดับไปด้วย

### ด้วย Docker

```bash
cd uptime
cp monitors.example.json monitors.json   # แก้รายการที่จะตรวจ
cp .env.example .env                     # ใส่รหัสผ่านและช่องทางแจ้งเตือน
docker compose up -d --build
```

เปิด http://localhost:3000

### ด้วย Node.js 22.13 ขึ้นไป

```bash
cd uptime
npm ci
cp monitors.example.json monitors.json
MYSQL_MONITOR_PASSWORD=... npm start
```

ข้อมูลเก็บที่ `data/uptime.db` เปลี่ยนที่ได้ด้วย `DATA_DIR`

## ตั้งค่า `monitors.json`

ค่ารวม (ใช้กับทุกรายการ แต่ละรายการตั้งทับได้):

| key | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `intervalSeconds` | 60 | ตรวจทุกกี่วินาที |
| `timeoutMs` | 10000 | รอได้นานสุดต่อชั้น |
| `failThreshold` | 2 | ล้มติดกันกี่ครั้งถึงนับว่าล่ม (กันแจ้งเตือนมั่วจากเน็ตกระตุก) เวลาเริ่มล่มจะนับจากครั้งแรกที่ล้ม |
| `retentionDays` | 90 | เก็บประวัติกี่วัน |
| `networkCanary` | ไม่ตั้ง | `host:port` ที่ควรติดต่อได้เสมอ เช่น `1.1.1.1:53` ถ้าตรวจล้มแล้วติดต่อจุดนี้ไม่ได้ด้วย แปลว่าเน็ตของตัวตรวจเองหลุด จะไม่นับรอบนั้น ถ้าเป็นวงแลนภายในที่ไม่มีอินเทอร์เน็ต ให้ใส่ gateway ของวงแลนแทน |

ชนิดที่รองรับ:

| `type` | key ที่ต้องมี | key เสริม |
|---|---|---|
| `http` | `url` | `method`, `headers`, `expectStatus`, `expectText`, `slowMs` |
| `ping` | `host` | |
| `tcp` | `host`, `port` | `slowMs` |
| `mysql` / `postgres` / `mssql` | `host`, `user`, `password` | `port`, `database`, `query`, `expectMinRows`, `expectValue: {column, min, max, equals}`, `slowMs`, `ssl` (mysql/postgres), `encrypt` / `trustServerCertificate` (mssql) |

ค่าใด ๆ เขียนเป็น `${ชื่อตัวแปร}` ได้ ระบบจะดึงจาก environment ไม่ต้องใส่รหัสผ่านไว้ในไฟล์

## สร้างผู้ใช้สำหรับ monitor (สิทธิ์น้อยที่สุด)

อย่าใช้บัญชี root/sa ให้สร้างผู้ใช้แยกที่อ่านได้แค่สิ่งที่ query ต้องใช้

```sql
-- MySQL / MariaDB
CREATE USER 'uptime_monitor'@'10.0.0.%' IDENTIFIED BY 'รหัสผ่านยาว ๆ';
GRANT SELECT ON app.orders TO 'uptime_monitor'@'10.0.0.%';
ALTER USER 'uptime_monitor'@'10.0.0.%' WITH MAX_USER_CONNECTIONS 2;

-- PostgreSQL
CREATE ROLE uptime_monitor LOGIN PASSWORD 'รหัสผ่านยาว ๆ' CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE app TO uptime_monitor;
GRANT SELECT ON orders TO uptime_monitor;

-- SQL Server
CREATE LOGIN uptime_monitor WITH PASSWORD = 'รหัสผ่านยาว ๆ';
USE App; CREATE USER uptime_monitor FOR LOGIN uptime_monitor;
GRANT SELECT ON dbo.Orders TO uptime_monitor;
```

## แจ้งเตือน

ตั้งใน `.env`:

- Telegram: `TELEGRAM_BOT_TOKEN` และ `TELEGRAM_CHAT_ID`
- Webhook: `WEBHOOK_URL` ส่ง JSON `{text, content, monitor, status}` ใช้กับ Discord, Slack, Google Chat หรือ n8n ได้

แจ้งเมื่อเริ่มล่ม (หลังล้มครบ `failThreshold`) และเมื่อกลับมา พร้อมบอกว่าล่มไปนานเท่าไร

## ความปลอดภัยของ dashboard

ตั้ง `DASHBOARD_USER` และ `DASHBOARD_PASSWORD` เพื่อล็อกด้วย Basic Auth หน้า dashboard ไม่แสดงรหัสผ่าน แต่แสดงชื่อเครื่องและพอร์ต ถ้าเปิดสู่อินเทอร์เน็ตควรวางหลัง HTTPS (เช่น Caddy หรือ Nginx)

## API

- `GET /api/summary` สถานะปัจจุบัน, uptime 24 ชม./7 วัน/30 วัน, uptime รายวัน 30 วัน
- `GET /api/monitors/:id/latency?hours=24` เวลาตอบย้อนหลัง
- `GET /api/incidents?limit=50` ประวัติเหตุขัดข้อง
- `GET /healthz` สถานะของตัวตรวจเอง (ไม่ต้องล็อกอิน)

## ทดสอบ

```bash
npm test
```
