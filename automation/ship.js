// 브로셔 신청(Firestore) → 탑스탠다드 사이트 택배 발송 → 배송완료 반영
// GitHub Actions에서 주기적으로 실행된다 (.github/workflows/brochure-shipping.yml)
import { mkdirSync } from "node:fs";
import admin from "firebase-admin";
import { chromium } from "playwright";

const SITE = "http://erp.topstandard.co.kr";
const APP_IDS = ["dm-team-mr-hub-v3", "onco-team-mr-hub-v3"]; // index.html의 사업부별 dataAppId
const DRY_RUN = process.env.DRY_RUN !== "false";
// 이 시각 이전 신청은 자동 발송하지 않는다 (기존에 수기로 처리한 건 보호). 자동화 시작일로 바꿀 것
const SHIP_SINCE = new Date("2026-11-01T00:00:00+09:00").getTime();

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const requestsOf = (appId) => db.collection("artifacts").doc(appId).collection("public").doc("data").collection("requests");

mkdirSync("screenshots", { recursive: true });

async function login(page) {
    await page.goto(`${SITE}/member/login.php`);
    await page.fill("#member_id", process.env.SHIP_ID);
    await page.fill("#member_password", process.env.SHIP_PW);
    await Promise.all([page.waitForLoadState("networkidle"), page.click("#frm input[type=image]")]);
    if (page.url().includes("login.php")) throw new Error("로그인 실패 — 아이디/비밀번호 확인");
}

// TODO(사이트 확인 후 작성): 택배 보내기 화면에서 신청 1건을 등록하고 사이트 주문번호를 반환
async function sendParcel(page, req) {
    // 예시 형태:
    // await page.goto(`${SITE}/...택배 보내기 화면...`);
    // await page.fill("#받는분", req.requesterName);
    // await page.fill("#연락처", req.phone);
    // await page.fill("#주소", req.address);
    // await page.fill("#품목", `${req.brochureName} ${req.quantity}부`);
    // await page.click("#등록버튼");
    // return await page.textContent("#주문번호");
    throw new Error("sendParcel 미구현");
}

// TODO(사이트 확인 후 작성): 주문번호로 배송 상태 조회 → { delivered, trackingNo }
async function checkDelivery(page, orderNo) {
    throw new Error("checkDelivery 미구현");
}

async function main() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await login(page);
        console.log(`로그인 성공 (DRY_RUN=${DRY_RUN})`);

        for (const appId of APP_IDS) {
            const snap = await requestsOf(appId).where("completed", "==", false).get();
            for (const doc of snap.docs) {
                const req = doc.data();
                const label = `[${appId}] ${req.requesterName} / ${req.brochureName} ${req.quantity}부`;

                // 1) 아직 안 보낸 신청 → 택배 등록. 등록 직후 바로 기록해서 중복 발송을 막는다
                if (!req.shipOrderNo) {
                    if ((req.timestamp || 0) < SHIP_SINCE) continue;
                    if (DRY_RUN) { console.log(`(DRY_RUN) 발송 예정: ${label}`); continue; }
                    const orderNo = await sendParcel(page, req);
                    await doc.ref.update({ shipOrderNo: orderNo, shipSentAt: Date.now() });
                    console.log(`발송 등록: ${label} → ${orderNo}`);
                    continue;
                }

                // 2) 보낸 신청 → 배송완료 확인
                const { delivered, trackingNo } = await checkDelivery(page, req.shipOrderNo);
                if (trackingNo && trackingNo !== req.trackingNo) await doc.ref.update({ trackingNo });
                if (delivered && !DRY_RUN) {
                    await doc.ref.update({ completed: true, deliveredAt: Date.now() });
                    console.log(`배송완료: ${label} (${trackingNo})`);
                }
            }
        }
    } catch (e) {
        await page.screenshot({ path: "screenshots/error.png", fullPage: true }).catch(() => {});
        throw e;
    } finally {
        await browser.close();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
