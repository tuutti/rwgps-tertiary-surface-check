// Background script: performs Postpass requests on behalf of the content script.
// Requests from here use the extension's host permissions, so the local server
// needs no CORS setup and Chrome's local-network-access prompt doesn't trigger.
const POSTPASS_URL = 'http://localhost:8081/interpreter';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'postpass') return false;
  fetch(POSTPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: msg.sql }),
  })
    .then(async (res) => sendResponse({ ok: res.ok, status: res.status, text: await res.text() }))
    .catch((e) => sendResponse({ ok: false, status: 0, text: String(e.message || e) }));
  return true; // async response
});
