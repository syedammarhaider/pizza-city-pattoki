# Pizza City POS — Nayi Laptop + Printer Guide

Ye guide Roman Urdu mein hai. Purana data (orders, menu, password) **`data` folder** ke andar hota hai — ise kabhi delete na karein.

---

## 1) Nayi Laptop par setup (step by step)

**Step 1 — Node.js install karein**
- Browser mein kholein: `https://nodejs.org`
- **LTS version** download karein ("Recommended for most users" wala, jaise v22.x ya v24.x)
- Installer chalayein → **Next → Next → Install** (saare defaults theek hain)
- Install ke baad laptop **restart** karein (zaroori hai)
- Check karne ke liye: `Win + R` dabayein, `cmd` likh kar Enter, phir `node -v` likhein — version nazar aaye to theek hai

**Step 2 — Program files copy karein**
- Purani laptop se yeh files copy karein (USB drive se):
  - `server.js`, `db.js`, `index.html`, `package.json`, `package-lock.json`, `config.json`
  - `public` folder (poora)
  - `start.bat`
  - **`data` folder (POORA — isme saari orders, menu, pictures aur password hai)**
  - `test.js` (optional)
- Nayi laptop par inhe ek folder mein rakhein, maslan `D:\PizzaCityPOS` ya `Desktop\PizzaCityPOS`

**Step 3 — Dependencies install karein**
- Us folder mein ja kar address bar mein `cmd` likh kar Enter dabayein
- Yeh command chalayein:
  ```
  npm install
  ```
  (sirf `better-sqlite3` install hogi — 1-2 minute)

**Step 4 — Chalayein**
- `start.bat` par double-click karein
- Browser khud `http://localhost:3000` par open ho jayega
- Password: agar purani laptop par custom password set kiya tha to wahi; warna `adminpizzacity`

> **Yaad rakhein:** server chalne ke liye woh black window **khuli rehni chahiye**. Window band = POS band.

---

## 2) Purani laptop ka data nayi laptop par kaise le jayein

`data` folder mein yeh hota hai:
- `pizza_city.db` — saari orders, menu, settings, password (ek hi file)
- `images` — item pictures (agar use ki hon)

**Tarika:**
1. Purani laptop par POS **band** karein (server window close karein)
2. `data` folder ko copy karein (USB/network se)
3. Nayi laptop par program folder ke andar purana `data` folder **replace** kar dein
4. `start.bat` chalayein — sab kuch waisa hi milega

Agar sirf kuch orders ki backup chahiye to `backups` folder dekhein — har din ka folder hota hai jisme `pizza_city.db` hoti hai.

**Restore (backup se wapas laana):**
1. POS band karein
2. `data\pizza_city.db` ko rename kar dein (maslan `pizza_city_old.db`)
3. Backup wali file ko copy karke `data\pizza_city.db` naam dein
4. `data` folder se `pizza_city.db-wal` aur `pizza_city.db-shm` files delete kar dein (agar hon)
5. `start.bat` chalayein

---

## 3) Printer setup — kam black ink, simple receipt

**Recommended printer:** 58mm ya 80mm **thermal receipt printer** (Xprinter, Epson TM-T20, Star TSP, etc.)
- Thermal printer par ink lagta hi nahi — ribbon/s ribbon nahi chahiye, bas thermal paper
- Isliye **long term mein thermal printer sab se sasta aur best hai**
- POS mein receipt width Settings se set hoti hai (58mm ya 80mm) — printer ke hisaab se choose karein

**Agar normal inkjet/laser printer use karna ho (kam black ke liye):**
1. Printer driver settings mein:
   - **Paper size:** 80mm roll ya 3 inch
   - **Print quality:** "Draft" / "Eco" / "Fast" mode chunein (best quality nahi)
   - **Color/Grayscale:** "Black & White" ya "Grayscale" select karein
   - **"Print Background Graphics" / "Background Colors" OFF** karein (browser print dialog mein checkbox hota hai)
2. Chrome print dialog (Ctrl+P) mein:
   - Destination: apna printer
   - Layout: Portrait
   - Paper size: 80mm (ya jo printer support kare)
   - Margins: **None / Default**
   - "Background graphics" **uncheck**
3. Receipt ab already light hai — token box, total box aur borders print par halki lines mein aate hain taake ink bache

**Paper saving tips:**
- Ek thermal roll (80mm × 80mm) par ~200 receipts aate hain
- Daily closing par receipts ko file mein rakh lein, computer se dobara print karne ki zaroorat nahi

---

## 4) Rozana use ka short formula

| Kaam | Tarika |
|---|---|
| POS chalana | `start.bat` double-click |
| Band karna | Server wali black window close karein |
| Orders dekhna | History tab (password maangega) |
| Sales report | Dashboard tab (password maangega) |
| Menu badalna | Menu Manager tab (password maangega) |
| Backup | Settings → Backup button (30 min mein auto bhi hota hai) |
| Password badalna | Settings → Password section |

---

## 5) Safety — ye cheezein hamesha yaad rakhein

- `data` folder **kabhi delete/copy-over na karein** — usi mein aapka sara business data hai
- `backups` folder ko bhi touch na karein — ye aapki safety hai
- Laptop band karne se pehle POS band kar dein (window close) — data safe rehta hai
- Anti-virus `data` folder ko quarantine na kare — agar ho to exclusion add karein
- Har hafte `data` folder ki ek copy USB mein le jayein (extra safety)
