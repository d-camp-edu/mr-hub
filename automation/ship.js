// 브로셔 신청(Firestore) → 탑스탠다드 사이트 택배 발송 → 출고 시 완료 반영
// GitHub Actions에서 주기적으로 실행된다 (.github/workflows/brochure-shipping.yml)
import { mkdirSync } from "node:fs";
import admin from "firebase-admin";
import { chromium } from "playwright";

const SITE = "http://erp.topstandard.co.kr";
const APP_IDS = ["dm-team-mr-hub-v3", "onco-team-mr-hub-v3"]; // index.html의 사업부별 dataAppId
const DRY_RUN = process.env.DRY_RUN !== "false";
// 이 시각 이전 신청은 자동 발송하지 않는다 (기존에 수기로 처리한 건 보호). 자동화 시작일로 바꿀 것
const SHIP_SINCE = new Date("2026-11-01T00:00:00+09:00").getTime();
// 주소록에 같은 이름이 여러 개인 사무소 → 주소(add1)에 이 글자가 있는 쪽을 고른다
const OFFICE_ADDR_HINT = { "제주사무소": "제주특별자치도" };
const STEP_SHIPPED = "2"; // 사이트 주문단계: 0 신청, 1 접수, 2 출고

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const dataOf = (appId) => db.collection("artifacts").doc(appId).collection("public").doc("data");

mkdirSync("screenshots", { recursive: true });

async function login(page) {
    await page.goto(`${SITE}/member/login.php`);
    await page.fill("#member_id", process.env.SHIP_ID);
    await page.fill("#member_password", process.env.SHIP_PW);
    await Promise.all([page.waitForLoadState("networkidle"), page.click("#frm input[type=image]")]);
    if (page.url().includes("login.php")) throw new Error("로그인 실패 — 아이디/비밀번호 확인");
}

// 브로셔 제목 → 관리자 화면에서 지정한 탑스탠다드 물품명 (messages 문서의 shipItemName)
async function loadItemNames(appId) {
    const snap = await dataOf(appId).collection("messages").where("category", "==", "제품 브로슈어").get();
    return new Map(snap.docs.map((d) => [d.data().title, (d.data().shipItemName || "").trim()]));
}

// 사이트 물품명으로 제품 키(gsKey)·물품 키(tgKey)·재고를 찾는다
function findItem(page, itemName) {
    return page.evaluate(async ({ itemName }) => {
        const $ = window.$;
        const tgoaId = $('form[id^="frm1_"] input[name=tgoa_id]').val();
        const tcKey = $('form[id^="frm1_"] input[name=tc_key]').val();
        const opts = await $.post("../distribution/register.php", { mode: "select_goods", tc_key: tcKey, tgoa_id: tgoaId, num: "1" });
        const products = [...$("<select>").html(opts)[0].options].filter((o) => o.value).map((o) => o.value);
        for (const gsKey of products) {
            const html = await $.post("../distribution/register.php", { mode: "goods_selected", gs_key: gsKey, dis_key: "", sch_text: "" });
            const hit = $("<div>").html(html).find(".inscnt").filter(function () {
                return $.trim($(this).closest("td").find("b").first().text()) === itemName;
            }).first();
            if (hit.length) return { gsKey, tgKey: hit.attr("tgkey"), stock: Number(String(hit.attr("stock")).replace(/,/g, "")) };
        }
        return null;
    }, { itemName });
}

// 물품신청 화면에서 1건 입력. submit이 false면 정보등록 직전까지만 확인한다.
// 사이트가 순서를 강제한다: 배송방법 → 출고물품 → 주소록 → 수취인 덮어쓰기 → 정보등록
async function sendParcel(page, req, itemName, { submit }) {
    await page.goto(`${SITE}/main/index.php`);
    // 메인의 공지 팝업(.popup_drag)이 버튼 클릭을 가리므로 치운다
    await page.evaluate(() => { document.querySelectorAll(".popup_drag").forEach((p) => p.remove()); window.get_page("/distribution/goods_ask_write.php"); });
    const form = page.locator('form[id^="frm1_"]');
    await form.locator('select[name="tgoai_send[1]"]').waitFor();

    const item = await findItem(page, itemName);
    if (!item) throw new Error(`사이트에 "${itemName}" 물품이 없음`);
    const qty = Number(req.quantity);
    if (!(qty > 0)) throw new Error(`수량이 잘못됨: ${req.quantity}`);
    if (qty > item.stock) throw new Error(`재고 부족: ${itemName} 재고 ${item.stock} < 신청 ${qty}`);

    // 1) 배송방법 택배
    await form.locator('select[name="tgoai_send[1]"]').selectOption("2");

    // 2) 출고 물품 등록: 제품 선택 → 물품 수량 → 수량등록완료 ("계속 등록?"은 dialog 핸들러가 취소)
    await form.locator('input[onclick^="input_info"]').click();
    await page.locator('select[name=goods_selected] option[value="' + item.gsKey + '"]').waitFor({ state: "attached" });
    await page.locator("select[name=goods_selected]").selectOption(item.gsKey);
    const qtyInput = page.locator(`.inscnt[tgkey="${item.tgKey}"]`);
    await qtyInput.fill(String(qty));
    await page.locator('input[onclick^="input_good_ins"]:visible').first().click();
    await form.locator(`input[name="tg_key1[]"][value="${item.tgKey}"]`).waitFor({ state: "attached" });

    // 3) 주소록에서 사무소 검색·선택 → 사무소 주소가 채워진다
    await form.locator("#add_in_1").click();
    const keyword = page.locator('input[placeholder="이름/메일/주소 검색"]');
    await keyword.fill(req.office);
    await keyword.press("Enter");
    await page.waitForFunction((office) => {
        const boxes = [...document.querySelectorAll('[class*="addr-chk-item"]')];
        return boxes.length > 0 && boxes.every((b) => decodeURIComponent(b.dataset.name || "").includes(office.split(" ")[0]));
    }, req.office);
    const picked = await page.evaluate(({ office, hint }) => {
        const boxes = [...document.querySelectorAll('[class*="addr-chk-item"]')]
            .filter((b) => decodeURIComponent(b.dataset.name || "") === office)
            .filter((b) => !hint || decodeURIComponent(b.dataset.add1 || "").includes(hint));
        if (boxes.length !== 1) return boxes.length;
        boxes[0].checked = true;
        return 1;
    }, { office: req.office, hint: OFFICE_ADDR_HINT[req.office] });
    if (picked !== 1) throw new Error(`주소록에서 "${req.office}"를 하나로 특정하지 못함 (${picked}건)`);
    await page.locator('input[onclick^="addr_select_done"]').click();
    if (!(await form.locator('input[name="tgoai_add1[1]"]').inputValue())) throw new Error("사무소 주소가 채워지지 않음");

    // 4) 수취인·전화번호는 사무소 대신 신청자로, 메모에 출고 물품
    await form.locator('input[name="tgoai_name[1]"]').fill(req.requesterName);
    await form.locator('input[name="tgoai_phone[1]"]').fill(req.phone);
    await form.locator('input[name="tgoai_text[1]"]').fill(`${itemName} ${qty}부`);

    if (!submit) return null;

    // 5) 정보등록 → register.php가 {is_success, code(주문코드), tgoa_key, msg} JSON을 돌려준다
    const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/distribution/register.php") && r.request().method() === "POST"),
        form.locator('input[onclick^="form_write"]').click(),
    ]);
    const data = await res.json();
    if (String(data.is_success) !== "1") throw new Error(`정보등록 실패: ${data.msg}`);
    return { orderNo: data.code, shipKey: String(data.tgoa_key) };
}

// 사이트 주문 상세의 주문단계·출고일자
function checkShipped(page, shipKey) {
    return page.evaluate(async (key) => {
        const html = await (await fetch(`/distribution/goods_ask_write.php?tgoa_key=${key}`)).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const val = (n) => doc.querySelector(`[name="${n}"]`)?.value || "";
        return { step: val("tgoa_step"), outDate: val("tgoa_out_date") };
    }, shipKey);
}

async function main() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    // 사이트의 alert은 닫고 기록만, "계속 등록하시겠습니까?" 같은 confirm은 취소
    page.on("dialog", async (d) => {
        console.log(`  [사이트 ${d.type()}] ${d.message().replace(/\s+/g, " ")}`);
        await (d.type() === "confirm" ? d.dismiss() : d.accept());
    });
    let failures = 0;
    try {
        await login(page);
        console.log(`로그인 성공 (DRY_RUN=${DRY_RUN})`);

        // 시험 입력: "물품명|사무소" 로 가짜 신청 1건을 정보등록 직전까지만 넣어 보고 끝낸다
        if (process.env.TEST_FILL) {
            const [itemName, office] = process.env.TEST_FILL.split("|").map((s) => s.trim());
            await sendParcel(page, { requesterName: "테스트", phone: "010-0000-0000", quantity: 1, office }, itemName, { submit: false });
            await page.screenshot({ path: "screenshots/test-fill.png", fullPage: true });
            console.log(`시험 입력 성공 (등록 안 함): ${itemName} 1부 → ${office}`);
            return;
        }

        for (const appId of APP_IDS) {
            const itemNames = await loadItemNames(appId);
            const snap = await dataOf(appId).collection("requests").where("completed", "==", false).get();
            for (const doc of snap.docs) {
                const req = doc.data();
                const label = `[${appId}] ${req.requesterName} / ${req.brochureName} ${req.quantity}부 → ${req.office}`;
                try {
                    // 1) 아직 안 보낸 신청 → 사이트에 물품신청. 등록 직후 바로 기록해서 중복 발송을 막는다
                    if (!req.shipOrderNo) {
                        if ((req.timestamp || 0) < SHIP_SINCE) continue;
                        const itemName = itemNames.get(req.brochureName);
                        if (!itemName) throw new Error(`"${req.brochureName}"에 탑스탠다드 물품명이 지정되지 않음 (관리자 > 브로셔 품목)`);
                        const result = await sendParcel(page, req, itemName, { submit: !DRY_RUN });
                        if (!result) { console.log(`(DRY_RUN) 정보등록 직전까지 확인 완료: ${label}`); continue; }
                        await doc.ref.update({ shipOrderNo: result.orderNo, shipKey: result.shipKey, shipSentAt: Date.now() });
                        console.log(`물품신청 등록: ${label} → ${result.orderNo}`);
                        continue;
                    }

                    // 2) 보낸 신청 → 사이트에서 출고되면 완료
                    const { step, outDate } = await checkShipped(page, req.shipKey);
                    if (step !== STEP_SHIPPED) continue;
                    if (DRY_RUN) { console.log(`(DRY_RUN) 출고 확인됨, 완료 처리 예정: ${label}`); continue; }
                    await doc.ref.update({ completed: true, shippedAt: Date.now(), shipOutDate: outDate });
                    console.log(`출고 완료 처리: ${label} (${outDate})`);
                } catch (e) {
                    // 한 건이 실패해도 나머지는 계속. 실행 결과는 실패로 남겨 GitHub 알림이 가게 한다
                    failures++;
                    console.error(`실패: ${label}\n  ${e.message}`);
                    await page.screenshot({ path: `screenshots/${doc.id}.png`, fullPage: true }).catch(() => {});
                }
            }
        }
    } catch (e) {
        await page.screenshot({ path: "screenshots/error.png", fullPage: true }).catch(() => {});
        throw e;
    } finally {
        await browser.close();
    }
    if (failures) throw new Error(`${failures}건 실패 — 위 로그와 screenshots 확인`);
}

main().catch((e) => { console.error(e); process.exit(1); });
