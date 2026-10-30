// 브로셔 택배 자동 발송 — 평일 KST 10시대에 하루 한 번 GitHub Actions 실행 요청
// GitHub 예약(schedule)이 자주 누락돼서 Apps Script 시간 트리거로 대신 깨움.
// 스크립트 속성에 GITHUB_TOKEN 을 넣어야 함 (프로젝트 설정 > 스크립트 속성).

const REPO = "d-camp-edu/mr-hub";
const WORKFLOW = "brochure-shipping.yml";

function runShipping() {
  const now = new Date();
  const day = Number(Utilities.formatDate(now, "Asia/Seoul", "u")); // 1=월 ~ 7=일
  if (day > 5) return;

  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  const res = UrlFetchApp.fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      payload: JSON.stringify({ ref: "main", inputs: { dry_run: "false" } }),
      muteHttpExceptions: true,
    }
  );
  // 204면 성공. 실패 시 실행 기록에 남고, 트리거 실패 알림 메일이 옴
  if (res.getResponseCode() !== 204) {
    throw new Error(`GitHub 실행 요청 실패 ${res.getResponseCode()}: ${res.getContentText()}`);
  }
}

// 처음 한 번만 실행 (주기를 바꿨으면 다시 실행): 기존 트리거를 지우고 매일 KST 10시대 트리거 생성
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("runShipping").timeBased().everyDays(1).atHour(10).inTimezone("Asia/Seoul").create();
}
