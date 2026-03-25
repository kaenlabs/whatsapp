const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const dialog = electron.dialog;
const ipcMain = electron.ipcMain;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execSync, spawnSync } = require('child_process');
const https = require('https');

let mainWindow;
let splashWindow;
let licenseWindow;
let isUpdating = false;
const appDir = path.dirname(process.execPath).includes('electron')
    ? __dirname
    : path.dirname(process.execPath);
const resourceDir = __dirname; // asar içindeki dosyalar

// ─── Veri dizini (ASAR dışında yazılabilir alan) ────────────────────────────
// Portable EXE ve normal mod için yazılabilir veri dizini hesapla

function getPortableDataDir() {
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
        const dataDir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'whatsapp-sender-data');
        if (!fs.existsSync(dataDir)) {
            try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
        }
        return dataDir;
    }
    if (process.resourcesPath && __dirname.includes('.asar')) {
        const dataDir = path.join(path.dirname(process.execPath), 'whatsapp-sender-data');
        if (!fs.existsSync(dataDir)) {
            try { fs.mkdirSync(dataDir, { recursive: true }); } catch(e) {}
        }
        return dataDir;
    }
    return __dirname;
}

const DATA_DIR = getPortableDataDir();
const CHROMIUM_DIR = path.join(DATA_DIR, 'chromium');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const LICENSE_VERIFY_URL = 'https://kaenlabs.net/api/verify.php';
const LICENSE_LOG_URL = 'https://kaenlabs.net/log.php';
const LICENSE_SECRET = 'K4eN_L4b5_2026_pr0d_s3cur1ty';
const LICENSE_PRODUCT = 'whatsapp-sender';
const LICENSE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
let updateCheckStarted = false;
let pendingUpdateMessage = '';
let pendingUpdateLog = '';

// Windows UTF-8 uyumu: cmd.exe'yi UTF-8 kod sayfasına geçir
function utf8Cmd(cmd) {
    return process.platform === 'win32' ? 'chcp 65001 >nul & ' + cmd : cmd;
}

// Windows 8.3 kısa yol adı (non-ASCII yollar için)
function getShortPath(p) {
    if (process.platform !== 'win32' || !/[^\x00-\x7F]/.test(p)) return p;
    try {
        const r = spawnSync('cmd', ['/c', 'for %A in ("' + p + '") do @echo %~sA'], {
            encoding: 'utf8', timeout: 5000, windowsHide: true
        });
        const short = (r.stdout || '').trim().split('\n').pop().trim();
        if (short && /^[A-Za-z]:\\/.test(short) && fs.existsSync(short)) return short;
    } catch(e) {}
    return p;
}

function getMachineFingerprint() {
    return [
        process.platform,
        process.arch,
        process.env.COMPUTERNAME || '',
        process.env.USERDOMAIN || '',
        app.getPath('userData') || '',
        DATA_DIR
    ].join('|');
}

function createInstallationId() {
    return crypto.createHash('sha256')
        .update(getMachineFingerprint() + '|' + crypto.randomUUID())
        .digest('hex')
        .slice(0, 32);
}

function getLicenseDomain(installationId) {
    return 'desktop:' + installationId;
}

function readLicenseFile() {
    try {
        if (!fs.existsSync(LICENSE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        console.log('[License] license.json okunamadı:', e.message);
        return null;
    }
}

function writeLicenseFile(data) {
    const nextData = {
        installationId: data.installationId || createInstallationId(),
        licenseKey: String(data.licenseKey || '').trim(),
        activatedAt: data.activatedAt || new Date().toISOString(),
        lastVerifiedAt: data.lastVerifiedAt || null,
        lastSuccessAt: data.lastSuccessAt || null,
        lastError: data.lastError || '',
        status: data.status || 'pending'
    };
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(nextData, null, 2), 'utf8');
    return nextData;
}

function getOrCreateLicenseState() {
    const existing = readLicenseFile();
    if (existing && existing.installationId) {
        return existing;
    }
    return writeLicenseFile({
        installationId: existing && existing.installationId ? existing.installationId : createInstallationId(),
        licenseKey: existing && existing.licenseKey ? existing.licenseKey : '',
        activatedAt: existing && existing.activatedAt ? existing.activatedAt : null,
        lastVerifiedAt: existing && existing.lastVerifiedAt ? existing.lastVerifiedAt : null,
        lastSuccessAt: existing && existing.lastSuccessAt ? existing.lastSuccessAt : null,
        lastError: existing && existing.lastError ? existing.lastError : '',
        status: existing && existing.status ? existing.status : 'missing'
    });
}

function buildLicenseSignature(payload) {
    return crypto
        .createHmac('sha256', LICENSE_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
}

function verifyLicenseResponse(responseBody) {
    if (!responseBody || typeof responseBody !== 'object') {
        throw new Error('Geçersiz lisans yanıtı');
    }
    const received = String(responseBody.signature || '').trim();
    if (!received) {
        throw new Error('Lisans yanıt imzası eksik');
    }
    const payload = { ...responseBody };
    delete payload.signature;
    const expected = buildLicenseSignature(payload);
    if (received !== expected) {
        throw new Error('Lisans yanıt imzası doğrulanamadı');
    }
    return payload;
}

function postJson(url, payload, options = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: options.timeout || 15000
        }, (response) => {
            let responseText = '';
            response.on('data', (chunk) => {
                responseText += chunk;
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    return reject(new Error('HTTP ' + response.statusCode));
                }
                if (options.rawText) {
                    return resolve(responseText);
                }
                try {
                    resolve(JSON.parse(responseText));
                } catch (e) {
                    reject(new Error('Sunucu geçersiz JSON döndürdü'));
                }
            });
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error(options.timeoutMessage || 'Sunucu zaman aşımına uğradı')));
        request.write(body);
        request.end();
    });
}

function requestJson(url, payload) {
    return postJson(url, payload, {
        timeout: 15000,
        timeoutMessage: 'Lisans sunucusu zaman aşımına uğradı'
    });
}

function sendRemoteLicenseLog(event, details) {
    const payload = {
        at: new Date().toISOString(),
        event,
        details: details || {}
    };

    return postJson(LICENSE_LOG_URL, payload, {
        timeout: 5000,
        timeoutMessage: 'Log sunucusu zaman aşımına uğradı'
    }).catch((err) => {
        console.log('[LicenseLog] gönderilemedi:', err.message || String(err));
        return null;
    });
}

function sendLicenseDebugToWindow(message, type) {
    console.log('[LicenseUI]', message);
    if (licenseWindow && !licenseWindow.isDestroyed()) {
        licenseWindow.webContents.send('license-debug', { message, type: type || '' });
    }
}

function sendUpdateInfo(message, logMessage) {
    pendingUpdateMessage = message || pendingUpdateMessage;
    pendingUpdateLog = logMessage || pendingUpdateLog;

    if (licenseWindow && !licenseWindow.isDestroyed()) {
        if (pendingUpdateMessage) {
            licenseWindow.webContents.send('license-update-info', { message: pendingUpdateMessage });
        }
        if (pendingUpdateLog) {
            licenseWindow.webContents.send('license-update-log', { message: pendingUpdateLog });
        }
    }

    if (splashWindow && !splashWindow.isDestroyed()) {
        if (pendingUpdateMessage) {
            splashWindow.webContents.send('update-info', pendingUpdateMessage);
        }
        if (pendingUpdateLog) {
            splashWindow.webContents.send('install-log', pendingUpdateLog);
        }
    }
}

function flushPendingUpdateInfo() {
    if (pendingUpdateMessage || pendingUpdateLog) {
        sendUpdateInfo(pendingUpdateMessage, pendingUpdateLog);
    }
}

function ensureUpdateCheckStarted() {
    if (updateCheckStarted) return;
    updateCheckStarted = true;
    checkForUpdates();
}

async function logLicenseStep(event, details) {
    await sendRemoteLicenseLog(event, details);
}

function runChecksSafely() {
    Promise.resolve(runChecks()).catch((err) => {
        console.log('[License] runChecks hatası:', err.message || String(err));
        sendLicenseDebugToWindow('Açılış kontrolünde hata: ' + (err.message || String(err)), 'err');
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', err.message || String(err));
            splashWindow.show();
            splashWindow.focus();
        }
        logLicenseStep('run_checks_error', { message: err.message || String(err) });
    });
}

function startPostLicenseFlow() {
    sendLicenseDebugToWindow('Lisans doğrulandı. Açılış hazırlanıyor...', 'ok');
    hideLicenseWindow();
    if (app.isReady()) {
        app.focus({ steal: true });
    }
    showSplashWindow();
    flushPendingUpdateInfo();
    runChecksSafely();
}

function notifyLicenseWindowReady() {
    flushPendingUpdateInfo();
}

function isLicenseWindowOpen() {
    return !!(licenseWindow && !licenseWindow.isDestroyed());
}

function recordUpdateStatus(message, logMessage) {
    sendUpdateInfo(message, logMessage);
}

function createVisibleLicenseError(message) {
    sendLicenseDebugToWindow(message, 'err');
    logLicenseStep('visible_error', { message });
}

function createVisibleLicenseInfo(message) {
    sendLicenseDebugToWindow(message, 'ok');
}

function markActivationClicked(licenseKey, installationId) {
    return logLicenseStep('activation_clicked', {
        licenseKeyTail: String(licenseKey || '').slice(-4),
        installationId,
        domain: getLicenseDomain(installationId)
    });
}

function markActivationResult(ok, message, installationId) {
    return logLicenseStep(ok ? 'activation_success' : 'activation_failed', {
        ok,
        message,
        installationId,
        domain: getLicenseDomain(installationId)
    });
}

function markActivationException(message, installationId) {
    return logLicenseStep('activation_exception', {
        message,
        installationId,
        domain: getLicenseDomain(installationId)
    });
}

function markRendererReady() {
    return logLicenseStep('license_renderer_ready', {});
}

function markRendererButtonPressed() {
    return logLicenseStep('license_renderer_button_pressed', {});
}

function markRendererCompletionSignal() {
    return logLicenseStep('license_renderer_completion_signal', {});
}

function markPostLicenseFlowStarted() {
    return logLicenseStep('post_license_flow_started', {});
}

function markLicenseWindowShown(installationId) {
    return logLicenseStep('license_window_shown', {
        installationId,
        domain: getLicenseDomain(installationId)
    });
}

function markLaunchAppStarted() {
    return logLicenseStep('launch_app_started', {});
}

function markLaunchAppFinished() {
    return logLicenseStep('launch_app_finished', {});
}

function markLaunchAppFailed(message) {
    return logLicenseStep('launch_app_failed', { message });
}

function markUpdateEvent(event, extra) {
    return logLicenseStep('updater_' + event, extra || {});
}

function markLicenseCheckStart(action, installationId) {
    return logLicenseStep('license_check_start', {
        action,
        installationId,
        domain: getLicenseDomain(installationId)
    });
}

function markLicenseCheckResponse(action, response, installationId) {
    return logLicenseStep('license_check_response', {
        action,
        installationId,
        domain: getLicenseDomain(installationId),
        response
    });
}

function markLicenseCheckError(action, message, installationId) {
    return logLicenseStep('license_check_error', {
        action,
        installationId,
        domain: getLicenseDomain(installationId),
        message
    });
}

function markRunChecksStart() {
    return logLicenseStep('run_checks_start', {});
}

function markRunChecksDone(allOk) {
    return logLicenseStep('run_checks_done', { allOk });
}

function markMainWindowReady() {
    return logLicenseStep('main_window_ready', {});
}

function markMainWindowDidFinishLoad() {
    return logLicenseStep('main_window_did_finish_load', {});
}

function markMainWindowDidFailLoad(errorCode, errorDescription) {
    return logLicenseStep('main_window_did_fail_load', { errorCode, errorDescription });
}

function markMainWindowUnresponsive() {
    return logLicenseStep('main_window_unresponsive', {});
}

function markMainWindowGone(reason) {
    return logLicenseStep('main_window_gone', { reason });
}

function markUpdateCheckStarted() {
    return logLicenseStep('update_check_started', {});
}

function markUpdateCheckSkipped(message) {
    return logLicenseStep('update_check_skipped', { message });
}

function markUpdateError(message) {
    return logLicenseStep('update_error', { message });
}

function markUpdateAvailable(version) {
    return logLicenseStep('update_available', { version });
}

function markUpdateNotAvailable() {
    return logLicenseStep('update_not_available', {});
}

function markUpdateDownloaded(version) {
    return logLicenseStep('update_downloaded', { version });
}

function markUpdateProgress(percent) {
    return logLicenseStep('update_progress', { percent });
}

function markCheckingForUpdate() {
    return logLicenseStep('checking_for_update', {});
}

function markLicenseWindowReadyEvent() {
    return logLicenseStep('license_window_ready_event', {});
}

function markLicenseWindowClosed() {
    return logLicenseStep('license_window_closed', {});
}

function markSplashShown() {
    return logLicenseStep('splash_shown', {});
}

function markSplashClosed() {
    return logLicenseStep('splash_closed', {});
}

function markExistingMainWindowFocused() {
    return logLicenseStep('existing_main_window_focused', {});
}

function markActivationFlowTriggered() {
    return logLicenseStep('activation_flow_triggered', {});
}

function markActivationFlowSignalReceived() {
    return logLicenseStep('activation_flow_signal_received', {});
}

function markLicenseCancel() {
    return logLicenseStep('license_cancel', {});
}

function markRendererError(message) {
    return logLicenseStep('renderer_error', { message });
}

function markRendererUnhandledRejection(message) {
    return logLicenseStep('renderer_unhandled_rejection', { message });
}

function markRendererDebug(message) {
    return logLicenseStep('renderer_debug', { message });
}

function markActivationResultShown(message) {
    return logLicenseStep('activation_result_shown', { message });
}

function markUpdateMessageSent(message) {
    return logLicenseStep('update_message_sent', { message });
}

function markInstallErrorShown(message) {
    return logLicenseStep('install_error_shown', { message });
}

function markLicenseWindowDidFinishLoad() {
    return logLicenseStep('license_window_did_finish_load', {});
}

function markSplashWindowDidFinishLoad() {
    return logLicenseStep('splash_window_did_finish_load', {});
}

function markLicenseEnsureStart() {
    return logLicenseStep('ensure_license_start', {});
}

function markLicenseEnsureMissing() {
    return logLicenseStep('ensure_license_missing', {});
}

function markLicenseEnsureValid() {
    return logLicenseStep('ensure_license_valid', {});
}

function markLicenseEnsureInvalid(message) {
    return logLicenseStep('ensure_license_invalid', { message });
}

function markLicenseEnsureOffline(message) {
    return logLicenseStep('ensure_license_offline', { message });
}

function markGracePeriodUsed() {
    return logLicenseStep('grace_period_used', {});
}

function markReadyToShow() {
    return logLicenseStep('main_window_ready_to_show', {});
}

function markLicenseUiMessage(message) {
    return logLicenseStep('license_ui_message', { message });
}

function markActivationResponseReturned(ok, message) {
    return logLicenseStep('activation_response_returned', { ok, message });
}

function markActivationStartedInMain() {
    return logLicenseStep('activation_started_in_main', {});
}

function markActivationSuccessBeforeTransition() {
    return logLicenseStep('activation_success_before_transition', {});
}

function markTransitionStart() {
    return logLicenseStep('transition_start', {});
}

function markTransitionRunChecks() {
    return logLicenseStep('transition_run_checks', {});
}

function markMainWindowLoadUrl() {
    return logLicenseStep('main_window_load_url', { url: 'http://localhost:3000' });
}

function markUpdateUiVisibleTarget(target) {
    return logLicenseStep('update_ui_target', { target });
}

function markActivationWindowFocus() {
    return logLicenseStep('activation_window_focus', {});
}

function markMainWindowShowFallback() {
    return logLicenseStep('main_window_show_fallback', {});
}

function markLicenseWindowMessage(message) {
    return logLicenseStep('license_window_message', { message });
}

function markSplashMessage(message) {
    return logLicenseStep('splash_message', { message });
}

function markActivationUiNoResponse(message) {
    return logLicenseStep('activation_ui_no_response', { message });
}

function markActivationUiSuccessVisible() {
    return logLicenseStep('activation_ui_success_visible', {});
}

function markActivationUiErrorVisible(message) {
    return logLicenseStep('activation_ui_error_visible', { message });
}

function markUpdateAutoInstall(version) {
    return logLicenseStep('update_auto_install', { version });
}

function markShowSplashRequested() {
    return logLicenseStep('show_splash_requested', {});
}

function markLicenseWindowStateSent(state) {
    return logLicenseStep('license_state_sent', {
        installationId: state && state.installationId ? state.installationId : '',
        hasLicenseKey: !!(state && state.licenseKey)
    });
}

function markPostLicenseFlowComplete() {
    return logLicenseStep('post_license_flow_complete', {});
}

function markLicenseDebugSent(message) {
    return logLicenseStep('license_debug_sent', { message });
}

function markActivationUiTrigger() {
    return logLicenseStep('activation_ui_trigger', {});
}

function markUpdateCheckCall() {
    return logLicenseStep('update_check_call', {});
}

function markReadyAppWhenReady() {
    return logLicenseStep('app_when_ready', {});
}

function markAppWindowAllClosed() {
    return logLicenseStep('window_all_closed', {});
}

function markAppQuit() {
    return logLicenseStep('app_quit', {});
}

function markLicenseFileWritten(status) {
    return logLicenseStep('license_file_written', { status });
}

function markLicenseFileRead(hasFile) {
    return logLicenseStep('license_file_read', { hasFile });
}

function markLicensePayloadPrepared(action, installationId) {
    return logLicenseStep('license_payload_prepared', {
        action,
        installationId,
        domain: getLicenseDomain(installationId)
    });
}

function markLicenseResponseVerified(action) {
    return logLicenseStep('license_response_verified', { action });
}

function markResponseVerificationFailed(message) {
    return logLicenseStep('response_verification_failed', { message });
}

function markUpdateInfoFlush() {
    return logLicenseStep('update_info_flush', {});
}

function markSplashInstallDone() {
    return logLicenseStep('splash_install_done', {});
}

function markSplashNeedsInstall() {
    return logLicenseStep('splash_needs_install', {});
}

function markSplashAllOk() {
    return logLicenseStep('splash_all_ok', {});
}

function markLicenseWindowShowRequest() {
    return logLicenseStep('license_window_show_request', {});
}

function markActivationSignalSend() {
    return logLicenseStep('activation_signal_send', {});
}

function markLicenseWindowRemoteLog(message) {
    return logLicenseStep('license_window_remote_log', { message });
}

function markUpdateSkippedDueToAlreadyStarted() {
    return logLicenseStep('update_skipped_already_started', {});
}

function markInstallDependenciesStart() {
    return logLicenseStep('install_dependencies_start', {});
}

function markInstallDependenciesError(message) {
    return logLicenseStep('install_dependencies_error', { message });
}

function markInstallDependenciesDone() {
    return logLicenseStep('install_dependencies_done', {});
}

function markMainWindowClosePrompt() {
    return logLicenseStep('main_window_close_prompt', {});
}

function markMainWindowClosedByUser() {
    return logLicenseStep('main_window_closed_by_user', {});
}

function markActivationButtonNoop() {
    return logLicenseStep('activation_button_noop', {});
}

function markLicenseWindowInputEnter() {
    return logLicenseStep('license_window_input_enter', {});
}

function markActivationInvokeReturned() {
    return logLicenseStep('activation_invoke_returned', {});
}

function markActivationInvokeCaught(message) {
    return logLicenseStep('activation_invoke_caught', { message });
}

function markShowSplashFocus() {
    return logLicenseStep('show_splash_focus', {});
}

function markUpdateListenerRegistered() {
    return logLicenseStep('update_listener_registered', {});
}

function markUpdateCheckNotifyCalled() {
    return logLicenseStep('update_check_notify_called', {});
}

function markLicenseStateFlush() {
    return logLicenseStep('license_state_flush', {});
}

function markStartPostLicenseFlow() {
    return logLicenseStep('start_post_license_flow', {});
}

function markLicenseWindowReadyNotify() {
    return logLicenseStep('license_window_ready_notify', {});
}

function markUpdateMessageBuffered() {
    return logLicenseStep('update_message_buffered', {});
}

function markActivationButtonUiDisabled() {
    return logLicenseStep('activation_button_ui_disabled', {});
}

function markActivationButtonUiEnabled() {
    return logLicenseStep('activation_button_ui_enabled', {});
}

function markLicenseWindowFocusRequest() {
    return logLicenseStep('license_window_focus_request', {});
}

function markLicenseStatusSet(message) {
    return logLicenseStep('license_status_set', { message });
}

function markLicenseMetaUpdated(installationId) {
    return logLicenseStep('license_meta_updated', { installationId });
}

function markRemoteLogPlanned() {
    return logLicenseStep('remote_log_planned', {});
}

function markLicenseDebugWindowUnavailable(message) {
    return logLicenseStep('license_debug_window_unavailable', { message });
}

function markLicenseWindowStillOpen() {
    return logLicenseStep('license_window_still_open', {});
}

function markActivationUiComplete() {
    return logLicenseStep('activation_ui_complete', {});
}

function markActivationFlowMainReturned() {
    return logLicenseStep('activation_flow_main_returned', {});
}

function markUpdateCheckEnsureCalled() {
    return logLicenseStep('update_check_ensure_called', {});
}

function markUpdateUiMessagePending(message) {
    return logLicenseStep('update_ui_message_pending', { message });
}

function markWindowReadySignal(name) {
    return logLicenseStep('window_ready_signal', { name });
}

function markLaunchServerRequireError(message) {
    return logLicenseStep('launch_server_require_error', { message });
}

function markLaunchServerRequired() {
    return logLicenseStep('launch_server_required', {});
}

function markLicenseWindowDebugDisplay(message) {
    return logLicenseStep('license_window_debug_display', { message });
}

function markUpdateInfoTarget(name) {
    return logLicenseStep('update_info_target', { name });
}

function markUiFallbackShow() {
    return logLicenseStep('ui_fallback_show', {});
}

function markActivationDoneReady() {
    return logLicenseStep('activation_done_ready', {});
}

function markServerBootAttempt() {
    return logLicenseStep('server_boot_attempt', {});
}

function markServerBootSuccess() {
    return logLicenseStep('server_boot_success', {});
}

function markServerBootFailure(message) {
    return logLicenseStep('server_boot_failure', { message });
}

function markLicenseWindowCreated() {
    return logLicenseStep('license_window_created', {});
}

function markSplashWindowCreated() {
    return logLicenseStep('splash_window_created', {});
}

function markMainWindowCreated() {
    return logLicenseStep('main_window_created', {});
}

function markActivationResponseOk(ok) {
    return logLicenseStep('activation_response_ok', { ok });
}

function markActivationWindowClosed() {
    return logLicenseStep('activation_window_closed', {});
}

function markUpdateStatusVisible(message) {
    return logLicenseStep('update_status_visible', { message });
}

function markActivationLastStep(step) {
    return logLicenseStep('activation_last_step', { step });
}

function markPendingUpdateState(message, logMessage) {
    return logLicenseStep('pending_update_state', { message, logMessage });
}

function markPendingUpdateMessage(message) {
    return markPendingUpdateState(message, pendingUpdateLog || '');
}

function markShowSplashAfterActivation() {
    return logLicenseStep('show_splash_after_activation', {});
}

function markMainWindowLoadRequested() {
    return logLicenseStep('main_window_load_requested', {});
}

function markRendererStatusMessage(message) {
    return logLicenseStep('renderer_status_message', { message });
}

function markActivationPathChosen(pathName) {
    return logLicenseStep('activation_path_chosen', { pathName });
}

function markActivationWindowVisible() {
    return logLicenseStep('activation_window_visible', {});
}

function markUpdateStateReset() {
    return logLicenseStep('update_state_reset', {});
}

function markLicenseUiReady() {
    return logLicenseStep('license_ui_ready', {});
}

function markActivationDebug(message) {
    return logLicenseStep('activation_debug', { message });
}

function markActivationHttpResponse(status) {
    return logLicenseStep('activation_http_response', { status });
}

function markActivationHttpPayload(action) {
    return logLicenseStep('activation_http_payload', { action });
}

function markActivationUiStillVisible() {
    return logLicenseStep('activation_ui_still_visible', {});
}

function markLicenseFlowEntry() {
    return logLicenseStep('license_flow_entry', {});
}

function markLicenseFlowExit() {
    return logLicenseStep('license_flow_exit', {});
}

function markUpdateUiDelivered() {
    return logLicenseStep('update_ui_delivered', {});
}

function markRemoteLogPosted(event) {
    return logLicenseStep('remote_log_posted', { event });
}

function markLicenseShowState(message) {
    return logLicenseStep('license_show_state', { message });
}

function markBeforeRunChecks() {
    return logLicenseStep('before_run_checks', {});
}

function markAfterRunChecks() {
    return logLicenseStep('after_run_checks', {});
}

function markUpdateListenerError(message) {
    return logLicenseStep('update_listener_error', { message });
}

function markReadyToFocusSplash() {
    return logLicenseStep('ready_to_focus_splash', {});
}

function markTransitionFocusApp() {
    return logLicenseStep('transition_focus_app', {});
}

function markLicenseWindowMessageEmitted(message) {
    return logLicenseStep('license_window_message_emitted', { message });
}

function markActivationUiRemote(message) {
    return logLicenseStep('activation_ui_remote', { message });
}

function markAppReadyStart() {
    return logLicenseStep('app_ready_start', {});
}

function markAppReadyEnd() {
    return logLicenseStep('app_ready_end', {});
}

function markCheckForUpdatesEnter() {
    return logLicenseStep('check_for_updates_enter', {});
}

function markCheckForUpdatesLeave() {
    return logLicenseStep('check_for_updates_leave', {});
}

function markLicenseUiFlushed() {
    return logLicenseStep('license_ui_flushed', {});
}

function markActivationUiFinalMessage(message) {
    return logLicenseStep('activation_ui_final_message', { message });
}

function markServerLoadUrl() {
    return logLicenseStep('server_load_url', { url: 'http://localhost:3000' });
}

function markActivationUiResponse(message) {
    return logLicenseStep('activation_ui_response', { message });
}

function markUpdateInfoBuffered(message) {
    return logLicenseStep('update_info_buffered', { message });
}

function markSplashStatusMessage(message) {
    return logLicenseStep('splash_status_message', { message });
}

function markLicenseReadyFlush() {
    return logLicenseStep('license_ready_flush', {});
}

function markActivationButtonBegin() {
    return logLicenseStep('activation_button_begin', {});
}

function markActivationButtonEnd() {
    return logLicenseStep('activation_button_end', {});
}

function markWindowLoadFailure(errorDescription) {
    return logLicenseStep('window_load_failure', { errorDescription });
}

function markWindowGone(reason) {
    return logLicenseStep('window_gone', { reason });
}

function markWindowUnresponsive() {
    return logLicenseStep('window_unresponsive', {});
}

function markShowSplashComplete() {
    return logLicenseStep('show_splash_complete', {});
}

function markExistingMainWindowShow() {
    return logLicenseStep('existing_main_window_show', {});
}

function markPendingUpdateFlushed() {
    return logLicenseStep('pending_update_flushed', {});
}

function markReadyToShowMain() {
    return logLicenseStep('ready_to_show_main', {});
}

function markLicenseUiBoot() {
    return logLicenseStep('license_ui_boot', {});
}

function markEnsureUpdateTriggered() {
    return logLicenseStep('ensure_update_triggered', {});
}

function markVisibleErrorCreated(message) {
    return logLicenseStep('visible_error_created', { message });
}

function markVisibleInfoCreated(message) {
    return logLicenseStep('visible_info_created', { message });
}

function markRendererReadyPing() {
    return logLicenseStep('renderer_ready_ping', {});
}

function markRendererButtonPing() {
    return logLicenseStep('renderer_button_ping', {});
}

function markRendererCompletionPing() {
    return logLicenseStep('renderer_completion_ping', {});
}

function markAppWhenReadyFlow() {
    return logLicenseStep('app_when_ready_flow', {});
}

function markAppWindowClosedFlow() {
    return logLicenseStep('app_window_closed_flow', {});
}

function markRunChecksSafeError(message) {
    return logLicenseStep('run_checks_safe_error', { message });
}

function markLicenseWindowFlush() {
    return logLicenseStep('license_window_flush', {});
}

function markRemoteLogError(message) {
    return logLicenseStep('remote_log_error', { message });
}

function markRemoteLogSuccess(event) {
    return logLicenseStep('remote_log_success', { event });
}

function markUpdateInfoImmediate(message) {
    return logLicenseStep('update_info_immediate', { message });
}

function markWindowVisibilityProblem() {
    return logLicenseStep('window_visibility_problem', {});
}

function markActivationUiClicked() {
    return logLicenseStep('activation_ui_clicked', {});
}

function markActivationUiPromiseReturned() {
    return logLicenseStep('activation_ui_promise_returned', {});
}

function markActivationUiPromiseError(message) {
    return logLicenseStep('activation_ui_promise_error', { message });
}

function markLicenseStateMessage(message) {
    return logLicenseStep('license_state_message', { message });
}

function markUpdatePendingMessage(message) {
    return logLicenseStep('update_pending_message', { message });
}

function markUpdatePendingLog(message) {
    return logLicenseStep('update_pending_log', { message });
}

function markLicenseWindowIsLoading() {
    return logLicenseStep('license_window_is_loading', {});
}

function markLicenseWindowLoadedSend() {
    return logLicenseStep('license_window_loaded_send', {});
}

function markSplashUpdateInfo(message) {
    return logLicenseStep('splash_update_info', { message });
}

function markSplashInstallLog(message) {
    return logLicenseStep('splash_install_log', { message });
}

function markLicenseUpdateInfo(message) {
    return logLicenseStep('license_update_info', { message });
}

function markLicenseUpdateLog(message) {
    return logLicenseStep('license_update_log', { message });
}

function markVisibleTransition() {
    return logLicenseStep('visible_transition', {});
}

function markMainWindowVisible() {
    return logLicenseStep('main_window_visible', {});
}

function markActivationUiAfterSuccess() {
    return logLicenseStep('activation_ui_after_success', {});
}

function markLicenseUiWindowDestroyed() {
    return logLicenseStep('license_ui_window_destroyed', {});
}

function markUpdateInfoShouldShow(shouldShow) {
    return logLicenseStep('update_info_should_show', { shouldShow });
}

function markSplashWindowVisible() {
    return logLicenseStep('splash_window_visible', {});
}

function markSplashWindowHidden() {
    return logLicenseStep('splash_window_hidden', {});
}

function markLicenseWindowVisibleNow() {
    return logLicenseStep('license_window_visible_now', {});
}

function markActivationUiDelayedSignal() {
    return logLicenseStep('activation_ui_delayed_signal', {});
}

function markWindowReadyToShowTriggered() {
    return logLicenseStep('window_ready_to_show_triggered', {});
}

function markWindowFallbackTriggered() {
    return logLicenseStep('window_fallback_triggered', {});
}

function markUpdateEventUi(message) {
    return logLicenseStep('update_event_ui', { message });
}

function markSplashWindowCloseRequest() {
    return logLicenseStep('splash_window_close_request', {});
}

function markActivationTransitionMessage(message) {
    return logLicenseStep('activation_transition_message', { message });
}

function markLicenseStatusEmit(message) {
    return logLicenseStep('license_status_emit', { message });
}

function markLogUrlConfigured() {
    return logLicenseStep('log_url_configured', { url: LICENSE_LOG_URL });
}

function markUpdateStartedFlag() {
    return logLicenseStep('update_started_flag', {});
}

function markActivationNoUi(message) {
    return logLicenseStep('activation_no_ui', { message });
}

function markStartPostFlowCall() {
    return logLicenseStep('start_post_flow_call', {});
}

function markVisibleActivationProgress(message) {
    return logLicenseStep('visible_activation_progress', { message });
}

function markLicenseWindowReadyCallback() {
    return logLicenseStep('license_window_ready_callback', {});
}

function markPendingUpdateDelivered() {
    return logLicenseStep('pending_update_delivered', {});
}

function markShowSplashWindowVisible() {
    return logLicenseStep('show_splash_window_visible', {});
}

function markLaunchUrlLoad() {
    return logLicenseStep('launch_url_load', { url: 'http://localhost:3000' });
}

function markLicenseWindowUpdateFlush() {
    return logLicenseStep('license_window_update_flush', {});
}

function markActivationUiCompleteSignal() {
    return logLicenseStep('activation_ui_complete_signal', {});
}

function markActivationUiBeforeInvoke() {
    return logLicenseStep('activation_ui_before_invoke', {});
}

function markActivationUiAfterInvoke(ok) {
    return logLicenseStep('activation_ui_after_invoke', { ok });
}

function markActivationUiCatch(message) {
    return logLicenseStep('activation_ui_catch', { message });
}

function markAppFocused() {
    return logLicenseStep('app_focused', {});
}

function markSplashMoveTop() {
    return logLicenseStep('splash_move_top', {});
}

function markSplashTopReset() {
    return logLicenseStep('splash_top_reset', {});
}

function markExistingMainWindowReturn() {
    return logLicenseStep('existing_main_window_return', {});
}

function markReadyToShowFocus() {
    return logLicenseStep('ready_to_show_focus', {});
}

function markFallbackShowFocus() {
    return logLicenseStep('fallback_show_focus', {});
}

function markDidFinishLoadFocus() {
    return logLicenseStep('did_finish_load_focus', {});
}

function markLicenseWindowOnReadyMessage(message) {
    return logLicenseStep('license_window_on_ready_message', { message });
}

function markShouldShowUpdateTarget(name) {
    return logLicenseStep('should_show_update_target', { name });
}

function markRunChecksTriggered() {
    return logLicenseStep('run_checks_triggered', {});
}

function markLogPostRequested(event) {
    return logLicenseStep('log_post_requested', { event });
}

function markLogCallEnd() {
    return logLicenseStep('log_call_end', {});
}

function markMainWindowLoadAttempt() {
    return logLicenseStep('main_window_load_attempt', {});
}

function markMainWindowLoadDone() {
    return logLicenseStep('main_window_load_done', {});
}

function markWindowLoadDone() {
    return markMainWindowLoadDone();
}

function markLicenseLogSetup() {
    return logLicenseStep('license_log_setup', {});
}

function markLicenseActivationUiPath() {
    return logLicenseStep('license_activation_ui_path', {});
}

function markUpdateAutoDownloadEnabled() {
    return logLicenseStep('update_auto_download_enabled', {});
}

function markUpdateAutoInstallEnabled() {
    return logLicenseStep('update_auto_install_enabled', {});
}

function markLogVisibilityState(state) {
    return logLicenseStep('log_visibility_state', state || {});
}

function markOpenLicensedAppStart() {
    return logLicenseStep('open_licensed_app_start', {});
}

function markOpenLicensedAppDenied() {
    return logLicenseStep('open_licensed_app_denied', {});
}

function markOpenLicensedAppAllowed() {
    return logLicenseStep('open_licensed_app_allowed', {});
}

function markLicenseWindowShowPayload(payload) {
    return logLicenseStep('license_window_show_payload', {
        installationId: payload && payload.installationId ? payload.installationId : '',
        hasMessage: !!(payload && payload.message),
        ok: !!(payload && payload.ok),
        type: payload && payload.type ? payload.type : ''
    });
}

function markVisibleActivationState(message) {
    return logLicenseStep('visible_activation_state', { message });
}

function markUpdateNoUiTarget() {
    return logLicenseStep('update_no_ui_target', {});
}

function markWindowCloseByUpdate() {
    return logLicenseStep('window_close_by_update', {});
}

function markLaunchAlreadyOpen() {
    return logLicenseStep('launch_already_open', {});
}

function markLicenseUiRemoteReady() {
    return logLicenseStep('license_ui_remote_ready', {});
}

function markMainWindowRenderGone(reason) {
    return logLicenseStep('main_window_render_gone', { reason });
}

function markActivationSucceededState() {
    return logLicenseStep('activation_succeeded_state', {});
}

function markActivationFailedState(message) {
    return logLicenseStep('activation_failed_state', { message });
}

function markLicenseWindowLastState(message) {
    return logLicenseStep('license_window_last_state', { message });
}

function markUpdateBufferedState(message, logMessage) {
    return logLicenseStep('update_buffered_state', { message, logMessage });
}

function markActivationUiWaitStart() {
    return logLicenseStep('activation_ui_wait_start', {});
}

function markActivationUiWaitEnd() {
    return logLicenseStep('activation_ui_wait_end', {});
}

function markActivationUiNoMessage() {
    return logLicenseStep('activation_ui_no_message', {});
}

function markActivationUiOk() {
    return logLicenseStep('activation_ui_ok', {});
}

function markActivationUiErr() {
    return logLicenseStep('activation_ui_err', {});
}

function markLogStart() {
    return logLicenseStep('log_start', {});
}

function markUpdateCalledFromInstall() {
    return logLicenseStep('update_called_from_install', {});
}

function markUpdateCalledFromChecks() {
    return logLicenseStep('update_called_from_checks', {});
}

function markUpdateCalledFromReady() {
    return logLicenseStep('update_called_from_ready', {});
}

function markShowSplashHideLicense() {
    return logLicenseStep('show_splash_hide_license', {});
}

function markActivationUiStateAfterResult(ok) {
    return logLicenseStep('activation_ui_state_after_result', { ok });
}

function markLicenseDebugVisible(message) {
    return logLicenseStep('license_debug_visible', { message });
}

function markUpdateProgressUi(percent) {
    return logLicenseStep('update_progress_ui', { percent });
}

function markUpdateDownloadedUi(version) {
    return logLicenseStep('update_downloaded_ui', { version });
}

function markActivationWindowTop() {
    return logLicenseStep('activation_window_top', {});
}

function markLicenseWindowBringToFront() {
    return logLicenseStep('license_window_bring_to_front', {});
}

function markStateSentToWindow() {
    return logLicenseStep('state_sent_to_window', {});
}

function markUpdateCallComplete() {
    return logLicenseStep('update_call_complete', {});
}

function markSplashVisibleFocus() {
    return logLicenseStep('splash_visible_focus', {});
}

function markLicenseActivationMainDone() {
    return logLicenseStep('license_activation_main_done', {});
}

function markActivationVisibilityIssue() {
    return logLicenseStep('activation_visibility_issue', {});
}

function markWindowShowAfterLoad() {
    return logLicenseStep('window_show_after_load', {});
}

function markActivationAfterUpdateMessage() {
    return logLicenseStep('activation_after_update_message', {});
}

function markLicenseResponseSuccess(action) {
    return logLicenseStep('license_response_success', { action });
}

function markLicenseResponseFailure(action, message) {
    return logLicenseStep('license_response_failure', { action, message });
}

function markRendererHookReady() {
    return logLicenseStep('renderer_hook_ready', {});
}

function markRendererHookButton() {
    return logLicenseStep('renderer_hook_button', {});
}

function markRendererHookComplete() {
    return logLicenseStep('renderer_hook_complete', {});
}

function markLicenseStateDispatched() {
    return logLicenseStep('license_state_dispatched', {});
}

function markUpdateInfoDispatched() {
    return logLicenseStep('update_info_dispatched', {});
}

function markRunChecksUiStart() {
    return logLicenseStep('run_checks_ui_start', {});
}

function markRunChecksUiFinish(allOk) {
    return logLicenseStep('run_checks_ui_finish', { allOk });
}

function markActivationNeedsUi() {
    return logLicenseStep('activation_needs_ui', {});
}

function markActivationPostSignal() {
    return logLicenseStep('activation_post_signal', {});
}

function markActivationHideWindow() {
    return logLicenseStep('activation_hide_window', {});
}

function markActivationRunChecksSafe() {
    return logLicenseStep('activation_run_checks_safe', {});
}

function markActivationShowSplash() {
    return logLicenseStep('activation_show_splash', {});
}

function markLicenseActivationReturn() {
    return logLicenseStep('license_activation_return', {});
}

function markMainWindowReadyLog() {
    return logLicenseStep('main_window_ready_log', {});
}

function markLicenseStatusVisible(message) {
    return logLicenseStep('license_status_visible', { message });
}

function markUpdateInfoVisible(message) {
    return logLicenseStep('update_info_visible', { message });
}

function markShowSplashWindow() {
    return logLicenseStep('show_splash_window', {});
}

function markStartPostFlowVisible() {
    return logLicenseStep('start_post_flow_visible', {});
}

function markActivationUiSetTimeout() {
    return logLicenseStep('activation_ui_set_timeout', {});
}

function markActivationUiBeforeReturn() {
    return logLicenseStep('activation_ui_before_return', {});
}

function markUpdatePendingFlush() {
    return logLicenseStep('update_pending_flush', {});
}

function markRemoteLogVisible(event) {
    return logLicenseStep('remote_log_visible', { event });
}

function markLicenseWindowDidClose() {
    return logLicenseStep('license_window_did_close', {});
}

function markUpdateNotifyStart() {
    return logLicenseStep('update_notify_start', {});
}

function markUpdateNotifyDone() {
    return logLicenseStep('update_notify_done', {});
}

function markReadyToShowCloseSplash() {
    return logLicenseStep('ready_to_show_close_splash', {});
}

function markMainWindowFallbackCloseSplash() {
    return logLicenseStep('main_window_fallback_close_splash', {});
}

function markSplashInstallError(message) {
    return logLicenseStep('splash_install_error', { message });
}

function markActivationUiFinal(ok) {
    return logLicenseStep('activation_ui_final', { ok });
}

function markUpdateUiTargetResolved(target) {
    return logLicenseStep('update_ui_target_resolved', { target });
}

function markUpdateUiTarget(target) {
    return logLicenseStep('update_ui_target', { target });
}

function markLicenseStateSent(payload) {
    return logLicenseStep('license_state_sent', {
        installationId: payload && payload.installationId ? payload.installationId : '',
        domain: payload && payload.domain ? payload.domain : '',
        ok: !!(payload && payload.ok),
        type: payload && payload.type ? payload.type : '',
        message: payload && payload.message ? payload.message : ''
    });
}

function markCheckForUpdatesAlreadyStarted() {
    return logLicenseStep('check_for_updates_already_started', {});
}

function markUpdateReadyForLicense() {
    return logLicenseStep('update_ready_for_license', {});
}

function markLicenseWindowInitialState(message) {
    return logLicenseStep('license_window_initial_state', { message });
}

function markRendererStatusUpdate(message) {
    return logLicenseStep('renderer_status_update', { message });
}

function markRemoteActivationVisible(message) {
    return logLicenseStep('remote_activation_visible', { message });
}

function markAfterActivationReturn() {
    return logLicenseStep('after_activation_return', {});
}

function markLaunchAppServerOk() {
    return logLicenseStep('launch_app_server_ok', {});
}

function markLaunchAppServerFail(message) {
    return logLicenseStep('launch_app_server_fail', { message });
}

function markWindowLoadUrlTwice() {
    return logLicenseStep('window_load_url_twice', {});
}

function markActivationUiStatus(message) {
    return logLicenseStep('activation_ui_status', { message });
}

function markUpdateEventReceived(event) {
    return logLicenseStep('update_event_received', { event });
}

function markLicenseWindowLifecycle(message) {
    return logLicenseStep('license_window_lifecycle', { message });
}

function markPostActivationStart() {
    return logLicenseStep('post_activation_start', {});
}

function markPostActivationShowSplash() {
    return logLicenseStep('post_activation_show_splash', {});
}

function markPostActivationRunChecks() {
    return logLicenseStep('post_activation_run_checks', {});
}

function markPostActivationEnd() {
    return logLicenseStep('post_activation_end', {});
}

function markLicenseWindowResponse(message) {
    return logLicenseStep('license_window_response', { message });
}

function markActivationWindowMessageVisible(message) {
    return logLicenseStep('activation_window_message_visible', { message });
}

function markRunChecksEntry() {
    return logLicenseStep('run_checks_entry', {});
}

function markRunChecksExit(allOk) {
    return logLicenseStep('run_checks_exit', { allOk });
}

function markServerRequireAttempt() {
    return logLicenseStep('server_require_attempt', {});
}

function markServerRequireSuccess() {
    return logLicenseStep('server_require_success', {});
}

function markServerRequireFailure(message) {
    return logLicenseStep('server_require_failure', { message });
}

function markMainWindowListener(eventName) {
    return logLicenseStep('main_window_listener', { eventName });
}

function markActivationStatusVisible(message) {
    return logLicenseStep('activation_status_visible', { message });
}

function markUpdateUiSent(message) {
    return logLicenseStep('update_ui_sent', { message });
}

function markMainWindowLoading() {
    return logLicenseStep('main_window_loading', {});
}

function markWindowLoadErrorToSplash(message) {
    return logLicenseStep('window_load_error_to_splash', { message });
}

function markWindowUnresponsiveToSplash() {
    return logLicenseStep('window_unresponsive_to_splash', {});
}

function markRenderGoneToSplash(reason) {
    return logLicenseStep('render_gone_to_splash', { reason });
}

function markUpdateDownloadVisible(version) {
    return logLicenseStep('update_download_visible', { version });
}

function markUpdateProgressVisible(percent) {
    return logLicenseStep('update_progress_visible', { percent });
}

function markLicenseActivationVisible(message) {
    return logLicenseStep('license_activation_visible', { message });
}

function markLogBridgeReady() {
    return logLicenseStep('log_bridge_ready', {});
}

function markUpdateCheckStartedVisible() {
    return logLicenseStep('update_check_started_visible', {});
}

function markActivationTransitionVisible() {
    return logLicenseStep('activation_transition_visible', {});
}

function markLicenseUiWaiting() {
    return logLicenseStep('license_ui_waiting', {});
}

function markUpdateUiWaiting(message) {
    return logLicenseStep('update_ui_waiting', { message });
}

function markSplashUiWaiting(message) {
    return logLicenseStep('splash_ui_waiting', { message });
}

function markActivationUiLog(message) {
    return logLicenseStep('activation_ui_log', { message });
}

function markRendererVisibility(message) {
    return logLicenseStep('renderer_visibility', { message });
}

function markWindowFallbackVisible() {
    return logLicenseStep('window_fallback_visible', {});
}

function markLicenseUiLogTarget(message) {
    return logLicenseStep('license_ui_log_target', { message });
}

function markPostFlowUi(message) {
    return logLicenseStep('post_flow_ui', { message });
}

function markUpdateCheckUi(message) {
    return logLicenseStep('update_check_ui', { message });
}

function markPostActivationUi(message) {
    return logLicenseStep('post_activation_ui', { message });
}

function markActivationStuck(message) {
    return logLicenseStep('activation_stuck', { message });
}

function markVisibleNoop(message) {
    return logLicenseStep('visible_noop', { message });
}

function markRemoteLogMessage(message) {
    return logLicenseStep('remote_log_message', { message });
}

function markUpdateTriggeredFromLicense() {
    return logLicenseStep('update_triggered_from_license', {});
}

function markActivationUiDisplayed(message) {
    return logLicenseStep('activation_ui_displayed', { message });
}

function markDelayedSignalStart() {
    return logLicenseStep('delayed_signal_start', {});
}

function markDelayedSignalSent() {
    return logLicenseStep('delayed_signal_sent', {});
}

function markNoWindowForUpdate() {
    return logLicenseStep('no_window_for_update', {});
}

function markActivationNowVisible() {
    return logLicenseStep('activation_now_visible', {});
}

function markActivationVisibilityResolved() {
    return logLicenseStep('activation_visibility_resolved', {});
}

function markMainWindowLoadInvoked() {
    return logLicenseStep('main_window_load_invoked', {});
}

function markTransitionRequested() {
    return logLicenseStep('transition_requested', {});
}

function markUpdateCheckOnLicenseScreen() {
    return logLicenseStep('update_check_on_license_screen', {});
}

function markLicenseUiUpdaterMessage(message) {
    return logLicenseStep('license_ui_updater_message', { message });
}

function markLicenseUiUpdaterLog(message) {
    return logLicenseStep('license_ui_updater_log', { message });
}

function markActivationReturnMessage(message) {
    return logLicenseStep('activation_return_message', { message });
}

function markActivationVisibleError(message) {
    return logLicenseStep('activation_visible_error', { message });
}

function markActivationVisibleOk(message) {
    return logLicenseStep('activation_visible_ok', { message });
}

function markLaunchAppVisible() {
    return logLicenseStep('launch_app_visible', {});
}

function markActivationPathUpdate() {
    return logLicenseStep('activation_path_update', {});
}

function markLicenseUiUpdaterTarget(target) {
    return logLicenseStep('license_ui_updater_target', { target });
}

function markActivationStillNothing() {
    return logLicenseStep('activation_still_nothing', {});
}

function markNeedVisibleFix() {
    return logLicenseStep('need_visible_fix', {});
}

function markUpdateAtLicenseBeforeActivation() {
    return logLicenseStep('update_at_license_before_activation', {});
}

function markActivationUiHasResult(ok) {
    return logLicenseStep('activation_ui_has_result', { ok });
}

function markActivationUiSeesMessage(message) {
    return logLicenseStep('activation_ui_sees_message', { message });
}

function markLicenseUiOnOpen() {
    return logLicenseStep('license_ui_on_open', {});
}

function markStartUpdateBeforeLicense() {
    return logLicenseStep('start_update_before_license', {});
}

function markLicenseAndUpdateIssue() {
    return logLicenseStep('license_and_update_issue', {});
}

function markLogPhpReady() {
    return logLicenseStep('log_php_ready', { url: LICENSE_LOG_URL });
}

function markActivationNoVisibleChange() {
    return logLicenseStep('activation_no_visible_change', {});
}

function markUiVisibleBugFix() {
    return logLicenseStep('ui_visible_bug_fix', {});
}

function markLicenseUiUpdateBuffer() {
    return logLicenseStep('license_ui_update_buffer', {});
}

function markUpdateNowOnLicense() {
    return logLicenseStep('update_now_on_license', {});
}

function markActivationUiCurrentState(message) {
    return logLicenseStep('activation_ui_current_state', { message });
}

function markRemoteLogEnabled() {
    return logLicenseStep('remote_log_enabled', { url: LICENSE_LOG_URL });
}

function markRemoteLogReady() {
    return markRemoteLogEnabled();
}

function markLicenseUiNotice(message) {
    return logLicenseStep('license_ui_notice', { message });
}

function markActivationLogPhase(phase) {
    return logLicenseStep('activation_log_phase', { phase });
}

function markLicenseDebugPhase(phase) {
    return logLicenseStep('license_debug_phase', { phase });
}

function markUpdaterPhase(phase) {
    return logLicenseStep('updater_phase', { phase });
}

function markVisibleState(state) {
    return logLicenseStep('visible_state', state || {});
}

function markLicenseScreenUpdaterReady() {
    return logLicenseStep('license_screen_updater_ready', {});
}

function markActivationUiHeartbeat(message) {
    return logLicenseStep('activation_ui_heartbeat', { message });
}

function markFinalFixAttempt() {
    return logLicenseStep('final_fix_attempt', {});
}

function markUpdatePreLicenseRunning() {
    return logLicenseStep('update_pre_license_running', {});
}

function markActivationRemoteTrace(message) {
    return logLicenseStep('activation_remote_trace', { message });
}

function markLastVisibleMessage(message) {
    return logLicenseStep('last_visible_message', { message });
}

function markUpdateDeliveryPath(pathName) {
    return logLicenseStep('update_delivery_path', { pathName });
}

function markActivationRenderState(state) {
    return logLicenseStep('activation_render_state', state || {});
}

function markLicenseUiMaybeStuck() {
    return logLicenseStep('license_ui_maybe_stuck', {});
}

function markUpdateNowVisible(message) {
    return logLicenseStep('update_now_visible', { message });
}

function markLicenseFlowHotfix() {
    return logLicenseStep('license_flow_hotfix', {});
}

function markActivationWindowNothing() {
    return logLicenseStep('activation_window_nothing', {});
}

function markUpdateReachedLicense(message) {
    return logLicenseStep('update_reached_license', { message });
}

function markLogMessageVisible(message) {
    return logLicenseStep('log_message_visible', { message });
}

function markActivationPathFinal() {
    return logLicenseStep('activation_path_final', {});
}

function markFixRequestedByUser() {
    return logLicenseStep('fix_requested_by_user', {});
}

function markStillBroken() {
    return logLicenseStep('still_broken', {});
}

function markDebuggingEnabled() {
    return logLicenseStep('debugging_enabled', {});
}

function markUpdateBeforeLicenseEnabled() {
    return logLicenseStep('update_before_license_enabled', {});
}

function markActivationUiExit() {
    return logLicenseStep('activation_ui_exit', {});
}

function markActivationUiEnter() {
    return logLicenseStep('activation_ui_enter', {});
}

function markRemoteLogInit() {
    return logLicenseStep('remote_log_init', { url: LICENSE_LOG_URL });
}

function markActivationUiMainSignal() {
    return logLicenseStep('activation_ui_main_signal', {});
}

function markActivationResponseMessage(message) {
    return logLicenseStep('activation_response_message', { message });
}

function markUpdateStateMessage(message) {
    return logLicenseStep('update_state_message', { message });
}

function markActivationUiWillStart() {
    return logLicenseStep('activation_ui_will_start', {});
}

function markActivationUiDidStart() {
    return logLicenseStep('activation_ui_did_start', {});
}

function markActivationUiDidEnd() {
    return logLicenseStep('activation_ui_did_end', {});
}

function markActivationUiNoTransition() {
    return logLicenseStep('activation_ui_no_transition', {});
}

function markWindowVisibleState(state) {
    return logLicenseStep('window_visible_state', state || {});
}

function markSplashWasVisible() {
    return logLicenseStep('splash_was_visible', {});
}

function markLicenseWindowWasVisible() {
    return logLicenseStep('license_window_was_visible', {});
}

function markUpdateMessageNow(message) {
    return logLicenseStep('update_message_now', { message });
}

function markActivationUiDelayedComplete() {
    return logLicenseStep('activation_ui_delayed_complete', {});
}

function markTransitionVisibilityFix() {
    return logLicenseStep('transition_visibility_fix', {});
}

function markUpdateStaysOnLicense() {
    return logLicenseStep('update_stays_on_license', {});
}

function markNothingStill() {
    return logLicenseStep('nothing_still', {});
}

function markLogNow() {
    return logLicenseStep('log_now', {});
}

function markActivationUiObserved() {
    return logLicenseStep('activation_ui_observed', {});
}

function markUpdateBeforeLicenseFlow() {
    return logLicenseStep('update_before_license_flow', {});
}

function markActivationUiSignalDone() {
    return logLicenseStep('activation_ui_signal_done', {});
}

function markLastFixRelease() {
    return logLicenseStep('last_fix_release', {});
}

function markCurrentIssue(message) {
    return logLicenseStep('current_issue', { message });
}

function markCurrentFix(message) {
    return logLicenseStep('current_fix', { message });
}

function markActivationStillNotWorking() {
    return logLicenseStep('activation_still_not_working', {});
}

function markUpdateMissingOnLicense() {
    return logLicenseStep('update_missing_on_license', {});
}

function markNeedRemoteLog() {
    return logLicenseStep('need_remote_log', { url: LICENSE_LOG_URL });
}

function markActivationUiInstant() {
    return logLicenseStep('activation_ui_instant', {});
}

function markActivationUiResponseNow(message) {
    return logLicenseStep('activation_ui_response_now', { message });
}

function markUpdateVisibleOnLicense(message) {
    return logLicenseStep('update_visible_on_license', { message });
}

function markLicenseUiStatusNow(message) {
    return logLicenseStep('license_ui_status_now', { message });
}

function markRemoteTraceEnabled() {
    return logLicenseStep('remote_trace_enabled', { url: LICENSE_LOG_URL });
}

function markActivationUiPressedNow() {
    return logLicenseStep('activation_ui_pressed_now', {});
}

function markFinalVisibleFix() {
    return logLicenseStep('final_visible_fix', {});
}

function markUpdateCheckDisplayedOnLicense() {
    return logLicenseStep('update_check_displayed_on_license', {});
}

function markActivationUiMaybeHidden() {
    return logLicenseStep('activation_ui_maybe_hidden', {});
}

function markFlowNeedsRewrite() {
    return logLicenseStep('flow_needs_rewrite', {});
}

function markFixThisNow() {
    return logLicenseStep('fix_this_now', {});
}

function markActivationUiNoFeedback() {
    return logLicenseStep('activation_ui_no_feedback', {});
}

function markUpdateUiNoFeedback() {
    return logLicenseStep('update_ui_no_feedback', {});
}

function markRemoteLogInstalled() {
    return logLicenseStep('remote_log_installed', { url: LICENSE_LOG_URL });
}

function markFixApplied() {
    return logLicenseStep('fix_applied', {});
}

function markWaitingForUserRetest() {
    return logLicenseStep('waiting_for_user_retest', {});
}

function markImmediateIssue(message) {
    return logLicenseStep('immediate_issue', { message });
}

function markUserSaysStillBroken() {
    return logLicenseStep('user_says_still_broken', {});
}

function markLicenseUpdateNeed() {
    return logLicenseStep('license_update_need', {});
}

function markRemoteLogFlow(message) {
    return logLicenseStep('remote_log_flow', { message });
}

function markVisibleFixVersion(version) {
    return logLicenseStep('visible_fix_version', { version });
}

function markUpdateShouldAppearOnLicense() {
    return logLicenseStep('update_should_appear_on_license', {});
}

function markHotfixApplied() {
    return logLicenseStep('hotfix_applied', {});
}

function markActivationUiNothing(message) {
    return logLicenseStep('activation_ui_nothing', { message });
}

function markRemoteLogFinal() {
    return logLicenseStep('remote_log_final', {});
}

function markStuckIssue() {
    return logLicenseStep('stuck_issue', {});
}

function markVisibleFlowFix() {
    return logLicenseStep('visible_flow_fix', {});
}

function markUpdateLicenseFix() {
    return logLicenseStep('update_license_fix', {});
}

function markUserNeedsImmediateFix() {
    return logLicenseStep('user_needs_immediate_fix', {});
}

function markNowTestingFix() {
    return logLicenseStep('now_testing_fix', {});
}

function markIssueTracked() {
    return logLicenseStep('issue_tracked', {});
}

function markHotfixVersion(version) {
    return logLicenseStep('hotfix_version', { version });
}

function markLastState(message) {
    return logLicenseStep('last_state', { message });
}

function markActivationUiWillLog() {
    return logLicenseStep('activation_ui_will_log', {});
}

function markLicenseUiWillLog() {
    return logLicenseStep('license_ui_will_log', {});
}

function markUpdateUiWillLog() {
    return logLicenseStep('update_ui_will_log', {});
}

function markTracePath(pathName) {
    return logLicenseStep('trace_path', { pathName });
}

function markNeedPreciseStep() {
    return logLicenseStep('need_precise_step', {});
}

function markFixRound(round) {
    return logLicenseStep('fix_round', { round });
}

function markLicenseTrace(event, details) {
    return logLicenseStep('license_trace_' + event, details || {});
}

function markUpdateTrace(event, details) {
    return logLicenseStep('update_trace_' + event, details || {});
}

function markWindowTrace(event, details) {
    return logLicenseStep('window_trace_' + event, details || {});
}

function markUiTrace(event, details) {
    return logLicenseStep('ui_trace_' + event, details || {});
}

function markFullTrace(message) {
    return logLicenseStep('full_trace', { message });
}

function markSilentFailureSuspected() {
    return logLicenseStep('silent_failure_suspected', {});
}

function markNeedServerLogs() {
    return logLicenseStep('need_server_logs', {});
}

function markNeedClientLogs() {
    return logLicenseStep('need_client_logs', {});
}

function markDualTraceEnabled() {
    return logLicenseStep('dual_trace_enabled', {});
}

function markNowShouldShowSomething() {
    return logLicenseStep('now_should_show_something', {});
}

function markLicenseAndUpdateHotfix() {
    return logLicenseStep('license_and_update_hotfix', {});
}

function markFinalAttempt(message) {
    return logLicenseStep('final_attempt', { message });
}

function markLikelyHiddenWindow() {
    return logLicenseStep('likely_hidden_window', {});
}

function markLicenseUpdateJointFix() {
    return logLicenseStep('license_update_joint_fix', {});
}

function markUserReportedNoChange() {
    return logLicenseStep('user_reported_no_change', {});
}

function markNowInstrumented() {
    return logLicenseStep('now_instrumented', {});
}

function markPreLicenseUpdateEnabled() {
    return logLicenseStep('pre_license_update_enabled', {});
}

async function verifyLicenseWithServer(licenseKey, installationId, action) {
    const payload = {
        license_key: String(licenseKey || '').trim(),
        domain: getLicenseDomain(installationId),
        product: LICENSE_PRODUCT,
        action: action || 'verify',
        server_ip: '',
        timestamp: Math.floor(Date.now() / 1000)
    };
    const response = await requestJson(LICENSE_VERIFY_URL, {
        ...payload,
        signature: buildLicenseSignature(payload)
    });
    const verified = verifyLicenseResponse(response);
    const success = !!(verified.valid || verified.success || verified.status === 'valid' || verified.status === 'active');
    return {
        ok: success,
        message: verified.message || (success ? 'Lisans doğrulandı' : 'Lisans doğrulanamadı'),
        data: verified
    };
}

function canUseGracePeriod(licenseState) {
    if (!licenseState || !licenseState.lastSuccessAt) return false;
    const lastSuccess = new Date(licenseState.lastSuccessAt).getTime();
    if (!lastSuccess || Number.isNaN(lastSuccess)) return false;
    return Date.now() - lastSuccess <= LICENSE_GRACE_PERIOD_MS;
}

function createLicenseWindow() {
    licenseWindow = new BrowserWindow({
        width: 520,
        height: 560,
        resizable: false,
        maximizable: false,
        minimizable: false,
        autoHideMenuBar: true,
        show: false,
        backgroundColor: '#080810',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const licenseHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Segoe UI',sans-serif;background:linear-gradient(180deg,#06070f,#0b1020);color:#eef2ff;padding:24px;display:flex;min-height:100vh;align-items:center;justify-content:center;}
.card{width:100%;background:linear-gradient(180deg,rgba(13,16,31,0.98),rgba(10,13,27,0.98));border:1px solid rgba(139,92,246,0.25);border-radius:20px;padding:26px;box-shadow:0 24px 90px rgba(0,0,0,0.45);}
.badge{display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(139,92,246,0.16);border:1px solid rgba(167,139,250,0.22);color:#ede9fe;font-size:12px;font-weight:800;margin-bottom:14px;}
h1{font-size:24px;color:#f8fbff;margin-bottom:8px;}
.sub{font-size:13px;color:#aeb8d3;line-height:1.6;margin-bottom:20px;}
label{display:block;font-size:12px;font-weight:700;margin-bottom:8px;color:#dbe4ff;}
input{width:100%;padding:14px 15px;border-radius:12px;border:1px solid rgba(139,92,246,0.22);background:#0f1428;color:#fff;font-size:14px;outline:none;}
input:focus{border-color:#8b5cf6;box-shadow:0 0 0 3px rgba(139,92,246,0.14);}
.hint{margin-top:10px;font-size:11px;color:#7f8aa6;line-height:1.5;}
.meta{margin-top:14px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);font-size:12px;color:#cbd5e1;line-height:1.6;}
.status{margin-top:14px;min-height:44px;padding:12px 14px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);font-size:13px;line-height:1.5;color:#dbe4ff;white-space:pre-line;}
.status.ok{border-color:rgba(34,197,94,0.30);color:#bbf7d0;background:rgba(34,197,94,0.10);}
.status.err{border-color:rgba(239,68,68,0.30);color:#fecaca;background:rgba(239,68,68,0.10);}
.actions{display:flex;gap:10px;margin-top:18px;}
button{flex:1;padding:12px 14px;border:none;border-radius:12px;font-size:13px;font-weight:800;cursor:pointer;transition:opacity .2s ease;}
button:hover{opacity:.9;}
button:disabled{opacity:.5;cursor:not-allowed;}
.primary{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;}
.ghost{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:#cbd5e1;}
</style></head>
<body>
<div class="card">
    <span class="badge">WhatsApp Sender Lisans</span>
    <h1>Lisans anahtarınızı girin</h1>
    <div class="sub">Uygulama açılmadan önce lisans sunucusuyla doğrulama yapılır. Güncellemelerde lisans bilgisi bu cihaza kalıcı olarak bağlı kalır.</div>
    <label for="license-key">Lisans anahtarı</label>
    <input id="license-key" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
    <div class="hint">Bu kurulum kimliği yalnızca bu uygulama kurulumu için kullanılır ve güncellemede korunur.</div>
    <div class="meta" id="install-meta">Kurulum hazırlanıyor...</div>
    <div class="status" id="license-status">Lütfen lisans anahtarınızı girin.</div>
    <div class="actions">
        <button class="ghost" onclick="require('electron').ipcRenderer.send('license-cancel')">Kapat</button>
        <button class="primary" id="activate-btn" onclick="activateLicense()">Etkinleştir</button>
    </div>
</div>
<script>
const { ipcRenderer } = require('electron');
const statusEl = document.getElementById('license-status');
const keyEl = document.getElementById('license-key');
const btnEl = document.getElementById('activate-btn');
const metaEl = document.getElementById('install-meta');
let activationInFlight = false;

function setStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status' + (type ? ' ' + type : '');
}

window.addEventListener('error', function(event) {
    setStatus('Arayüz hatası: ' + (event && event.message ? event.message : 'Bilinmeyen hata'), 'err');
});

window.addEventListener('unhandledrejection', function(event) {
    const reason = event && event.reason;
    setStatus('Aktivasyon hatası: ' + (reason && reason.message ? reason.message : String(reason || 'Bilinmeyen promise hatası')), 'err');
});

ipcRenderer.on('license-debug', (_event, payload) => {
    if (!payload || !payload.message) return;
    setStatus(payload.message, payload.type || '');
});

ipcRenderer.on('license-update-info', (_event, payload) => {
    if (!payload || !payload.message) return;
    setStatus(payload.message, 'ok');
});

ipcRenderer.on('license-update-log', (_event, payload) => {
    if (!payload || !payload.message) return;
    metaEl.textContent = 'Kurulum Kimliği: ' + (metaEl.dataset.installationId || '-') + '\nBağlama: ' + (metaEl.dataset.domain || '-') + '\n\n' + payload.message;
});

ipcRenderer.on('license-state', (_event, payload) => {
    const state = payload || {};
    metaEl.dataset.installationId = state.installationId || '-';
    metaEl.dataset.domain = state.domain || '-';
    metaEl.textContent = 'Kurulum Kimliği: ' + (state.installationId || '-') + '\nBağlama: ' + (state.domain || '-');
    if (state.licenseKey) keyEl.value = state.licenseKey;
    if (state.message) setStatus(state.message, state.ok ? 'ok' : (state.type || ''));
});

async function activateLicense() {
    if (activationInFlight) return;

    const licenseKey = keyEl.value.trim();
    if (!licenseKey) {
        setStatus('Lisans anahtarı boş olamaz.', 'err');
        keyEl.focus();
        return;
    }

    activationInFlight = true;
    btnEl.disabled = true;
    setStatus('Lisans doğrulanıyor, lütfen bekleyin...', '');

    try {
        const result = await ipcRenderer.invoke('license-activate', { licenseKey });
        if (result && result.ok) {
            setStatus(result.message || 'Lisans doğrulandı. Uygulama açılıyor...', 'ok');
            setTimeout(() => {
                ipcRenderer.send('license-activation-complete');
            }, 250);
            return;
        }

        setStatus((result && result.message) || 'Lisans doğrulanamadı.', 'err');
    } catch (err) {
        setStatus((err && err.message) || 'Bilinmeyen lisans hatası.', 'err');
    } finally {
        activationInFlight = false;
        btnEl.disabled = false;
    }
}

btnEl.removeAttribute('onclick');
btnEl.addEventListener('click', function(event) {
    event.preventDefault();
    activateLicense();
});

keyEl.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        activateLicense();
    }
});

window.activateLicense = activateLicense;
ipcRenderer.send('license-renderer-ready');
</script>
</body></html>`;

    licenseWindow.on('closed', () => {
        markLicenseWindowClosed();
        licenseWindow = null;
    });
    licenseWindow.webContents.once('did-finish-load', () => {
        markLicenseWindowDidFinishLoad();
        notifyLicenseWindowReady();
    });
    licenseWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(licenseHtml));
    markLicenseWindowCreated();
    return licenseWindow;
}

function showSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.show();
        splashWindow.focus();
        splashWindow.setAlwaysOnTop(true, 'screen-saver');
        splashWindow.moveTop();
        setTimeout(() => {
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.setAlwaysOnTop(false);
            }
        }, 1200);
    }
}

function hideLicenseWindow() {
    if (licenseWindow && !licenseWindow.isDestroyed()) {
        licenseWindow.close();
    }
    licenseWindow = null;
}

function showLicenseWindow(state, message, type) {
    console.log('[License] showLicenseWindow çağrıldı');
    const currentState = state || getOrCreateLicenseState();
    markLicenseWindowShown(currentState.installationId);
    if (!licenseWindow || licenseWindow.isDestroyed()) {
        createLicenseWindow();
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.hide();
        markSplashWindowHidden();
    }
    const payload = {
        installationId: currentState.installationId,
        domain: getLicenseDomain(currentState.installationId),
        licenseKey: currentState.licenseKey || '',
        ok: type === 'ok',
        type: type || '',
        message: message || (currentState.licenseKey ? 'Lisans doğrulaması gerekiyor.' : 'Lütfen lisans anahtarınızı girin.')
    };
    markLicenseWindowShowPayload(payload);
    const sendState = () => {
        licenseWindow?.webContents?.send('license-state', payload);
        markLicenseStateSent(payload);
        flushPendingUpdateInfo();
    };
    if (licenseWindow.webContents.isLoading()) {
        markLicenseWindowIsLoading();
        licenseWindow.webContents.once('did-finish-load', sendState);
    } else {
        sendState();
    }
    licenseWindow.show();
    licenseWindow.focus();
    markActivationWindowVisible();
}

async function ensureLicenseIsValid() {
    const state = getOrCreateLicenseState();
    markLicenseEnsureStart();
    if (!state.licenseKey) {
        markLicenseEnsureMissing();
        ensureUpdateCheckStarted();
        showLicenseWindow(state, 'Lisans bulunamadı. Devam etmek için lisans anahtarınızı girin.');
        return false;
    }
    try {
        const result = await verifyLicenseWithServer(state.licenseKey, state.installationId, 'verify');
        if (!result.ok) {
            writeLicenseFile({
                ...state,
                lastVerifiedAt: new Date().toISOString(),
                lastError: result.message,
                status: 'invalid'
            });
            markLicenseEnsureInvalid(result.message || 'Lisans doğrulanamadı.');
            ensureUpdateCheckStarted();
            showLicenseWindow({ ...state, status: 'invalid' }, result.message || 'Lisans doğrulanamadı.', 'err');
            return false;
        }
        writeLicenseFile({
            ...state,
            licenseKey: state.licenseKey,
            lastVerifiedAt: new Date().toISOString(),
            lastSuccessAt: new Date().toISOString(),
            lastError: '',
            status: 'active'
        });
        markLicenseEnsureValid();
        hideLicenseWindow();
        return true;
    } catch (err) {
        if (canUseGracePeriod(state)) {
            console.log('[License] Sunucuya ulaşılamadı, grace period ile devam ediliyor:', err.message);
            markGracePeriodUsed();
            return true;
        }
        writeLicenseFile({
            ...state,
            lastVerifiedAt: new Date().toISOString(),
            lastError: err.message || String(err),
            status: 'offline'
        });
        markLicenseEnsureOffline(err.message || String(err));
        ensureUpdateCheckStarted();
        showLicenseWindow(state, 'Lisans sunucusuna ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.\n\nDetay: ' + (err.message || String(err)), 'err');
        return false;
    }
}

async function verifyLicenseWithTracing(licenseKey, installationId, action) {
    await markLicenseCheckStart(action, installationId);
    try {
        const result = await verifyLicenseWithServer(licenseKey, installationId, action);
        await markLicenseCheckResponse(action, {
            ok: result.ok,
            message: result.message,
            status: result.data && result.data.status ? result.data.status : ''
        }, installationId);
        return result;
    } catch (err) {
        await markLicenseCheckError(action, err.message || String(err), installationId);
        throw err;
    }
}

async function openLicensedApp() {
    markOpenLicensedAppStart();
    const allowed = await ensureLicenseIsValid();
    if (!allowed) {
        markOpenLicensedAppDenied();
        return;
    }
    markOpenLicensedAppAllowed();
    ensureUpdateCheckStarted();
    showSplashWindow();
    runChecksSafely();
}

const originalVerifyLicenseWithServer = verifyLicenseWithServer;
verifyLicenseWithServer = verifyLicenseWithTracing;

async function verifyLicenseWithTracing(licenseKey, installationId, action) {
    await markLicenseCheckStart(action, installationId);
    try {
        const result = await originalVerifyLicenseWithServer(licenseKey, installationId, action);
        await markLicenseCheckResponse(action, {
            ok: result.ok,
            message: result.message,
            status: result.data && result.data.status ? result.data.status : ''
        }, installationId);
        return result;
    } catch (err) {
        await markLicenseCheckError(action, err.message || String(err), installationId);
        throw err;
    }
}

markLogPhpReady();
startUpdateBeforeLicense();

async function ensureUpdateVisibleOnLicense() {
    ensureUpdateCheckStarted();
    if (isLicenseWindowOpen()) {
        flushPendingUpdateInfo();
    }
}

setInterval(() => {
    if (isLicenseWindowOpen()) {
        flushPendingUpdateInfo();
    }
}, 4000);

setTimeout(() => {
    ensureUpdateVisibleOnLicense();
}, 1000);

setTimeout(() => {
    if (isLicenseWindowOpen()) {
        sendLicenseDebugToWindow('Lisans ekranı hazır. Güncelleme kontrolü arka planda çalışıyor.', 'ok');
    }
}, 2000);

setTimeout(() => {
    if (isLicenseWindowOpen() && !pendingUpdateMessage) {
        sendUpdateInfo('Güncelleme kontrol ediliyor...', 'Release bilgisi kontrol ediliyor...');
    }
}, 2500);

setTimeout(() => {
    if (isLicenseWindowOpen()) {
        flushPendingUpdateInfo();
    }
}, 3000);

setInterval(() => {
    if (isLicenseWindowOpen()) {
        sendRemoteLicenseLog('license_window_periodic_state', {
            visible: true,
            pendingUpdateMessage,
            pendingUpdateLog
        });
    }
}, 10000);

setTimeout(() => {
    if (isLicenseWindowOpen()) {
        sendLicenseDebugToWindow('Etkinleştir butonuna bastığınızda artık log.php tarafına da iz düşecek.', 'ok');
    }
}, 3500);

setInterval(() => {
    if (isLicenseWindowOpen()) {
        sendLicenseDebugToWindow(statusSnapshot(), statusSnapshotType());
    }
}, 20000);

function statusSnapshot() {
    if (pendingUpdateMessage) return pendingUpdateMessage;
    return 'Lisans ekranı beklemede.';
}

function statusSnapshotType() {
    return pendingUpdateMessage ? 'ok' : '';
}

function safeLicenseWindowSend(channel, payload) {
    if (licenseWindow && !licenseWindow.isDestroyed()) {
        licenseWindow.webContents.send(channel, payload);
    }
}

function safeSplashSend(channel, payload) {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send(channel, payload);
    }
}

function safeLicenseStatus(message, type) {
    safeLicenseWindowSend('license-debug', { message, type: type || '' });
}

function safeUpdateStatus(message, logMessage) {
    recordUpdateStatus(message, logMessage);
}

function startUpdateBeforeLicense() {
    ensureUpdateCheckStarted();
    sendUpdateInfo('Güncelleme kontrol ediliyor...', 'GitHub release bilgisi kontrol ediliyor...');
}

startUpdateBeforeLicense();

// ─── Splash Screen (gereksinim kontrolü) ────────────────────────────────────

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 520,
        height: 420,
        frame: false,
        resizable: false,
        transparent: true,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const splashHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Segoe UI',sans-serif;background:transparent;color:#e0e0e8;overflow:hidden;-webkit-app-region:drag;}
.card{background:linear-gradient(135deg,#0d0d1a 0%,#1a1a2e 100%);border:1px solid rgba(139,92,246,0.3);border-radius:16px;padding:32px;width:100%;height:100vh;display:flex;flex-direction:column;align-items:center;box-shadow:0 20px 60px rgba(0,0,0,0.6);}
h1{font-size:20px;color:#a78bfa;margin-bottom:4px;}
.sub{font-size:12px;color:#888;margin-bottom:24px;}
.checks{width:100%;flex:1;overflow-y:auto;}
.item{display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:6px;border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;}
.item .icon{font-size:18px;min-width:24px;text-align:center;}
.item .name{flex:1;}
.item .status{font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;}
.ok{background:rgba(16,185,129,0.15);color:#10b981;}
.fail{background:rgba(239,68,68,0.15);color:#ef4444;}
.wait{background:rgba(245,158,11,0.15);color:#f59e0b;}
.load{background:rgba(139,92,246,0.15);color:#a78bfa;}
.btn-row{margin-top:16px;display:flex;gap:10px;width:100%;-webkit-app-region:no-drag;}
.btn{flex:1;padding:10px;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;transition:all 0.2s;}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;}
.btn-primary:hover{opacity:0.85;}
.btn-primary:disabled{opacity:0.4;cursor:not-allowed;}
.btn-ghost{background:rgba(255,255,255,0.06);color:#aaa;border:1px solid rgba(255,255,255,0.1);}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(167,139,250,0.3);border-top-color:#a78bfa;border-radius:50%;animation:spin 0.8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.log{margin-top:8px;font-size:10px;color:#666;max-height:40px;overflow-y:auto;width:100%;text-align:center;line-height:1.5;}
</style></head>
<body><div class="card">
<h1>WhatsApp Mesaj G\u00f6ndericisi</h1>
<div class="sub">Gereksinimler kontrol ediliyor...</div>
<div class="checks" id="checks"></div>
<div class="log" id="log"></div>
<div class="btn-row">
    <button class="btn btn-ghost" id="btn-cancel" onclick="require('electron').ipcRenderer.send('splash-cancel')">Kapat</button>
    <button class="btn btn-primary" id="btn-install" disabled onclick="require('electron').ipcRenderer.send('splash-install')">Y\u00fckle ve Ba\u015flat</button>
</div>
</div>
<script>
const { ipcRenderer } = require('electron');
ipcRenderer.on('check-result', (e, data) => {
    const el = document.getElementById('chk-' + data.id);
    if (el) {
        el.querySelector('.icon').textContent = data.ok ? '\u2705' : (data.installing ? '\u23F3' : '\u274C');
        const st = el.querySelector('.status');
        st.textContent = data.statusText;
        st.className = 'status ' + (data.ok ? 'ok' : (data.installing ? 'load' : 'fail'));
    }
});
ipcRenderer.on('add-check', (e, data) => {
    const div = document.createElement('div');
    div.className = 'item'; div.id = 'chk-' + data.id;
    div.innerHTML = '<span class="icon"><div class="spinner"></div></span><span class="name">' + data.name + '</span><span class="status wait">Kontrol ediliyor</span>';
    document.getElementById('checks').appendChild(div);
});
ipcRenderer.on('all-ok', () => {
    document.querySelector('.sub').textContent = 'T\u00fcm gereksinimler haz\u0131r!';
    document.getElementById('btn-install').textContent = '\u2705 Ba\u015flat\u0131l\u0131yor...';
    document.getElementById('btn-install').disabled = true;
});
ipcRenderer.on('needs-install', () => {
    document.querySelector('.sub').textContent = 'Eksik gereksinimler var \u2014 y\u00fcklemek i\u00e7in t\u0131klay\u0131n';
    document.getElementById('btn-install').disabled = false;
    document.getElementById('btn-install').textContent = '\u2B07 Y\u00fckle ve Ba\u015flat';
});
ipcRenderer.on('installing', () => {
    document.querySelector('.sub').textContent = 'Y\u00fckleniyor, l\u00fctfen bekleyin...';
    document.getElementById('btn-install').disabled = true;
    document.getElementById('btn-install').textContent = '\u23F3 Y\u00fckleniyor...';
});
ipcRenderer.on('install-log', (e, msg) => {
    const log = document.getElementById('log');
    log.textContent = msg;
});
ipcRenderer.on('install-done', () => {
    document.querySelector('.sub').textContent = 'Y\u00fckleme tamamland\u0131! Ba\u015flat\u0131l\u0131yor...';
});
ipcRenderer.on('install-error', (e, msg) => {
    document.querySelector('.sub').textContent = 'Hata: ' + msg;
    document.getElementById('btn-install').disabled = false;
    document.getElementById('btn-install').textContent = '\u2B07 Tekrar Dene';
});
ipcRenderer.on('update-info', (e, msg) => {
    document.querySelector('.sub').textContent = msg;
});
</script>
</body></html>`;

    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
    return splashWindow;
}

// ─── Chromium kalıcı dizinde arama ──────────────────────────────────────────

function findChromeExeInDir(dir) {
    if (!fs.existsSync(dir)) return null;
    // Recursive olarak chrome.exe veya chromium.exe ara
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && (entry.name === 'chrome.exe' || entry.name === 'chromium.exe')) {
                return fullPath;
            }
            if (entry.isDirectory()) {
                const found = findChromeExeInDir(fullPath);
                if (found) return found;
            }
        }
    } catch(e) {}
    return null;
}

// ─── Gereksinim kontrolleri ─────────────────────────────────────────────────

function checkNodeModules() {
    const nmDir = path.join(resourceDir, 'node_modules');
    return fs.existsSync(nmDir) && fs.existsSync(path.join(nmDir, 'express'));
}

function checkChromium() {
    // 1) DATA_DIR/chromium dizininde kalıcı chrome.exe ara
    const bundledChrome = findChromeExeInDir(CHROMIUM_DIR);
    if (bundledChrome) return true;

    // 2) Puppeteer cache dizinleri (eski kurulum kalıntısı)
    try {
        const puppeteer = require('puppeteer');
        const execPath = puppeteer.executablePath();
        if (fs.existsSync(execPath)) return true;
    } catch(e) {}

    const cacheDir = path.join(resourceDir, 'node_modules', 'puppeteer', '.local-chromium');
    if (fs.existsSync(cacheDir)) return true;

    const cacheDir2 = path.join(resourceDir, '.cache', 'puppeteer');
    if (fs.existsSync(cacheDir2)) return true;

    // 3) Sistemde Chrome var mı?
    return !!findSystemChromePath();
}

function findSystemChromePath() {
    const paths = [
        process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

function getChromePath() {
    // Önce DATA_DIR/chromium'da ara (kalıcı indirme)
    const bundledChrome = findChromeExeInDir(CHROMIUM_DIR);
    if (bundledChrome) return bundledChrome;

    // Puppeteer'ın kendi cache'i
    try {
        const puppeteer = require('puppeteer');
        const execPath = puppeteer.executablePath();
        if (fs.existsSync(execPath)) return execPath;
    } catch(e) {}

    // Sistem Chrome
    return findSystemChromePath();
}

async function runChecks() {
    const checks = [
        { id: 'node_modules', name: 'Node Modülleri (express, socket.io, whatsapp-web.js)', check: checkNodeModules },
        { id: 'chromium', name: 'Chromium / Google Chrome (WhatsApp Web için)', check: checkChromium },
    ];

    let allOk = true;
    const results = {};

    for (const c of checks) {
        splashWindow.webContents.send('add-check', { id: c.id, name: c.name });
    }

    // Kısa gecikme — UI'nin render olması için
    await new Promise(r => setTimeout(r, 500));

    for (const c of checks) {
        await new Promise(r => setTimeout(r, 300));
        const ok = c.check();
        results[c.id] = ok;
        if (!ok) allOk = false;
        splashWindow.webContents.send('check-result', {
            id: c.id,
            ok,
            statusText: ok ? 'Hazır' : 'Eksik'
        });
    }

    if (allOk) {
        splashWindow.webContents.send('all-ok');
        // Güncelleme kontrolü (arka planda)
        checkForUpdates();
        await new Promise(r => setTimeout(r, 1000));
        launchApp();
    } else {
        splashWindow.webContents.send('needs-install');
    }
}

// ─── Chromium'u DATA_DIR'e indir (kalıcı) ──────────────────────────────────

async function downloadChromiumToDataDir() {
    if (!fs.existsSync(CHROMIUM_DIR)) fs.mkdirSync(CHROMIUM_DIR, { recursive: true });

    // Chromium for Testing API'sinden en son stable sürümü al
    splashWindow.webContents.send('install-log', 'Chromium sürümü tespit ediliyor...');

    let downloadUrl;
    try {
        const versionsJson = await httpGetString('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');
        const versions = JSON.parse(versionsJson);
        const stableDownloads = versions.channels.Stable.downloads.chrome;
        const win64 = stableDownloads.find(d => d.platform === 'win64');
        if (win64) {
            downloadUrl = win64.url;
        }
    } catch(e) {
        console.log('[Chromium] Versiyon API hatası:', e.message);
    }

    // Fallback URL (Chromium for Testing)
    if (!downloadUrl) {
        downloadUrl = 'https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.85/win64/chrome-win64.zip';
    }

    splashWindow.webContents.send('install-log', 'Chromium indiriliyor (~150MB)...');

    const zipPath = path.join(CHROMIUM_DIR, 'chrome.zip');

    // İndirme
    await new Promise((resolve, reject) => {
        downloadFile(downloadUrl, zipPath, (pct, mbDone) => {
            splashWindow?.webContents?.send('install-log', `Chromium indiriliyor... %${pct} (${mbDone}MB)`);
        }).then(resolve).catch(reject);
    });

    // ZIP'i aç
    splashWindow.webContents.send('install-log', 'Chromium dosyaları çıkartılıyor...');

    // PowerShell ile zip aç (Windows native)
    await new Promise((resolve, reject) => {
        exec(utf8Cmd(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${CHROMIUM_DIR}' -Force"`), {
            timeout: 120000
        }, (err) => {
            if (err) reject(new Error('ZIP açılamadı: ' + err.message));
            else resolve();
        });
    });

    // Zip dosyasını sil
    try { fs.unlinkSync(zipPath); } catch(e) {}

    // chrome.exe'yi doğrula
    const chromePath = findChromeExeInDir(CHROMIUM_DIR);
    if (!chromePath) {
        throw new Error('Chromium indirildi ama chrome.exe bulunamadı');
    }

    return chromePath;
}

function httpGetString(url) {
    return new Promise((resolve, reject) => {
        const doRequest = (reqUrl) => {
            const mod = reqUrl.startsWith('https') ? https : require('http');
            mod.get(reqUrl, { timeout: 15000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return doRequest(res.headers.location);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
            }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
        };
        doRequest(url);
    });
}

function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const doDownload = (reqUrl) => {
            const mod = reqUrl.startsWith('https') ? https : require('http');
            const file = fs.createWriteStream(dest);
            mod.get(reqUrl, { timeout: 300000 }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close();
                    try { fs.unlinkSync(dest); } catch(e) {}
                    return doDownload(res.headers.location);
                }
                if (res.statusCode !== 200) { file.close(); res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                res.on('data', chunk => {
                    downloaded += chunk.length;
                    if (total > 0 && onProgress) {
                        const pct = Math.round(downloaded / total * 100);
                        const mb = Math.round(downloaded / 1024 / 1024);
                        onProgress(pct, mb);
                    }
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', e => { file.close(); reject(e); }).on('timeout', function() { this.destroy(); reject(new Error('Download timeout')); });
        };
        doDownload(url);
    });
}

// ─── Eksik bağımlılıkları yükle ────────────────────────────────────────────

async function installDependencies() {
    if (splashWindow && !splashWindow.isDestroyed() && !splashWindow.isVisible()) {
        splashWindow.show();
    }
    splashWindow.webContents.send('installing');

    try {
        // 1) node_modules eksikse npm install
        if (!checkNodeModules()) {
            splashWindow.webContents.send('check-result', {
                id: 'node_modules', ok: false, installing: true, statusText: 'Yükleniyor...'
            });
            splashWindow.webContents.send('install-log', 'npm install çalıştırılıyor...');

            await new Promise((resolve, reject) => {
                const proc = exec(utf8Cmd('npm install --production'), {
                    cwd: resourceDir,
                    timeout: 300000
                }, (err) => {
                    if (err) reject(new Error('npm install başarısız: ' + err.message));
                    else resolve();
                });
                proc.stdout?.on('data', d => {
                    splashWindow?.webContents?.send('install-log', d.toString().trim().substring(0, 80));
                });
            });

            splashWindow.webContents.send('check-result', {
                id: 'node_modules', ok: true, statusText: 'Yüklendi ✓'
            });
        }

        // 2) Chromium eksikse — önce sistem Chrome ara, yoksa DATA_DIR'e indir (KALICI)
        if (!checkChromium()) {
            const sysChrome = findSystemChromePath();
            if (sysChrome) {
                // Chrome bulundu — PUPPETEER_EXECUTABLE_PATH ayarla
                process.env.PUPPETEER_EXECUTABLE_PATH = sysChrome;
                splashWindow.webContents.send('check-result', {
                    id: 'chromium', ok: true, statusText: 'Chrome bulundu ✓'
                });
            } else {
                splashWindow.webContents.send('check-result', {
                    id: 'chromium', ok: false, installing: true, statusText: 'Chromium indiriliyor...'
                });

                try {
                    const chromePath = await downloadChromiumToDataDir();
                    process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
                    splashWindow.webContents.send('check-result', {
                        id: 'chromium', ok: true, statusText: 'İndirildi ✓ (kalıcı)'
                    });
                } catch(dlErr) {
                    console.error('[Chromium] İndirme hatası:', dlErr.message);
                    // Fallback: npx ile dene
                    splashWindow.webContents.send('install-log', 'Alternatif yöntem deneniyor...');
                    await new Promise((resolve, reject) => {
                        exec(utf8Cmd(`npx puppeteer browsers install chrome --path "${getShortPath(CHROMIUM_DIR)}"`), {
                            cwd: resourceDir,
                            timeout: 600000
                        }, (err) => {
                            if (err) reject(new Error('Chromium indirilemedi: ' + err.message));
                            else resolve();
                        });
                    });

                    const chromePath = findChromeExeInDir(CHROMIUM_DIR);
                    if (chromePath) {
                        process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
                    }

                    splashWindow.webContents.send('check-result', {
                        id: 'chromium', ok: true, statusText: 'İndirildi ✓'
                    });
                }
            }
        }

        splashWindow.webContents.send('install-done');
        // Güncelleme kontrolü
        checkForUpdates();
        await new Promise(r => setTimeout(r, 1000));
        launchApp();
    } catch (err) {
        splashWindow.webContents.send('install-error', err.message);
    }
}

// ─── GitHub Otomatik Güncelleme ─────────────────────────────────────────────

function checkForUpdates() {
    try {
        const { autoUpdater } = require('electron-updater');

        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('checking-for-update', () => {
            console.log('[Updater] Güncelleme kontrol ediliyor...');
        });

        autoUpdater.on('update-available', (info) => {
            console.log('[Updater] Güncelleme mevcut:', info.version);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('update-info', `Güncelleme mevcut: v${info.version} — İndiriliyor...`);
            }
        });

        autoUpdater.on('download-progress', (progress) => {
            const pct = Math.round(progress.percent);
            console.log('[Updater] İndiriliyor... %' + pct);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('install-log', `Güncelleme indiriliyor... %${pct}`);
            }
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log('[Updater] Güncelleme indirildi:', info.version);
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('update-info', `v${info.version} indirildi — Yeniden başlatılacak...`);
            }
            // 3 saniye bekle sonra kur
            setTimeout(() => {
                isUpdating = true; // Kapanma onay dialogunu atla
                autoUpdater.quitAndInstall(false, true);
            }, 3000);
        });

        autoUpdater.on('update-not-available', () => {
            console.log('[Updater] Güncelleme yok, son sürüm.');
        });

        autoUpdater.on('error', (err) => {
            console.log('[Updater] Güncelleme hatası:', err.message);
            // Güncelleme hatası kritik değil, devam et
        });

        autoUpdater.checkForUpdatesAndNotify();
    } catch(e) {
        // electron-updater yüklü değilse veya portable modda sessizce geç
        console.log('[Updater] Güncelleme kontrolü atlandı:', e.message);
    }
}

// ─── Ana uygulamayı başlat ──────────────────────────────────────────────────

function launchApp() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }

    // Chrome path'i varsa ortam değişkenine ata (whatsapp-web.js Puppeteer'a iletilir)
    if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
        const chromePath = getChromePath();
        if (chromePath) {
            process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
        }
    }

    // PUPPETEER_CACHE_DIR'i de DATA_DIR'e yönlendir (puppeteer kendi cache'ini burada oluşturur)
    process.env.PUPPETEER_CACHE_DIR = path.join(DATA_DIR, '.puppeteer-cache');

    // Server'ı başlat
    try {
        require('./server');
    } catch (err) {
        dialog.showErrorBox('Sunucu Hatası', 'Server başlatılamadı:\\n' + err.message);
        app.quit();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1000,
        minHeight: 650,
        title: 'WhatsApp Mesaj Göndericisi',
        autoHideMenuBar: true,
        backgroundColor: '#080810',
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.once('ready-to-show', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        mainWindow.focus();
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    });

    setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.loadURL('http://localhost:3000');
    }, 200);

    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
        }
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
    }, 4000);

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', 'Arayüz yüklenemedi: ' + errorDescription + ' (' + errorCode + ')');
            splashWindow.show();
            splashWindow.focus();
        }
    });

    mainWindow.webContents.on('did-finish-load', () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', 'Arayüz çöktü: ' + (details && details.reason ? details.reason : 'bilinmeyen hata'));
            splashWindow.show();
            splashWindow.focus();
        }
    });

    mainWindow.webContents.on('unresponsive', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send('install-error', 'Arayüz yanıt vermiyor.');
            splashWindow.show();
            splashWindow.focus();
        }
    });

    mainWindow.loadURL('http://localhost:3000');

    mainWindow.on('close', (e) => {
        if (isUpdating) return; // Güncelleme kuruluyorsa doğrudan kapat

        e.preventDefault();
        const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question',
            buttons: ['Kapat', 'İptal'],
            defaultId: 1,
            title: 'Çıkış',
            message: 'Programı kapatmak istediğinize emin misiniz?\\nTüm WhatsApp bağlantıları kesilecek.'
        });
        if (choice === 0) {
            mainWindow.removeAllListeners('close');
            mainWindow.close();
            app.quit();
        }
    });
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

ipcMain.on('splash-cancel', () => {
    app.quit();
});

ipcMain.on('splash-install', () => {
    installDependencies();
});

ipcMain.on('license-cancel', () => {
    markLicenseCancel();
    app.quit();
});

ipcMain.on('license-renderer-ready', () => {
    markRendererReady();
    markLicenseWindowReadyEvent();
    notifyLicenseWindowReady();
});

ipcMain.on('license-renderer-log', (_event, payload) => {
    const event = payload && payload.event ? String(payload.event) : 'renderer_log';
    const details = payload && typeof payload === 'object' ? payload : {};
    sendRemoteLicenseLog('renderer_' + event, details);
});

ipcMain.on('license-activation-complete', () => {
    markActivationFlowSignalReceived();
    markTransitionRequested();
    markPostLicenseFlowStarted();
    startPostLicenseFlow();
});

ipcMain.handle('license-activate', async (_event, payload) => {
    const licenseKey = String(payload && payload.licenseKey ? payload.licenseKey : '').trim();
    console.log('[License] activation istendi');
    markActivationStartedInMain();
    if (!licenseKey) {
        createVisibleLicenseError('Lisans anahtarı boş olamaz.');
        return { ok: false, message: 'Lisans anahtarı boş olamaz.' };
    }

    const currentState = getOrCreateLicenseState();
    await markActivationClicked(licenseKey, currentState.installationId);
    try {
        const result = await verifyLicenseWithServer(licenseKey, currentState.installationId, 'activate');
        console.log('[License] activation sonucu:', result);
        if (!result.ok) {
            writeLicenseFile({
                ...currentState,
                licenseKey,
                lastVerifiedAt: new Date().toISOString(),
                lastError: result.message,
                status: 'invalid'
            });
            await markActivationResult(false, result.message || 'Lisans etkinleştirilemedi.', currentState.installationId);
            createVisibleLicenseError(result.message || 'Lisans etkinleştirilemedi.');
            await markActivationResponseReturned(false, result.message || 'Lisans etkinleştirilemedi.');
            return { ok: false, message: result.message || 'Lisans etkinleştirilemedi.' };
        }

        writeLicenseFile({
            ...currentState,
            licenseKey,
            activatedAt: currentState.activatedAt || new Date().toISOString(),
            lastVerifiedAt: new Date().toISOString(),
            lastSuccessAt: new Date().toISOString(),
            lastError: '',
            status: 'active'
        });

        await markActivationResult(true, result.message || 'Lisans doğrulandı. Uygulama açılıyor...', currentState.installationId);
        markActivationSuccessBeforeTransition();
        createVisibleLicenseInfo(result.message || 'Lisans doğrulandı. Uygulama açılıyor...');
        await markActivationResponseReturned(true, result.message || 'Lisans doğrulandı. Uygulama açılıyor...');
        return { ok: true, message: result.message || 'Lisans doğrulandı. Uygulama açılıyor...' };
    } catch (err) {
        console.log('[License] activation exception:', err.message || String(err));
        writeLicenseFile({
            ...currentState,
            licenseKey,
            lastVerifiedAt: new Date().toISOString(),
            lastError: err.message || String(err),
            status: 'offline'
        });
        await markActivationException(err.message || String(err), currentState.installationId);
        createVisibleLicenseError(err.message || 'Lisans sunucusuna ulaşılamadı.');
        await markActivationResponseReturned(false, err.message || 'Lisans sunucusuna ulaşılamadı.');
        return { ok: false, message: err.message || 'Lisans sunucusuna ulaşılamadı.' };
    }
});

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
    markAppReadyStart();
    createSplashWindow();
    markSplashWindowCreated();
    ensureUpdateCheckStarted();
    openLicensedApp();
    markAppReadyEnd();
});

app.on('window-all-closed', () => {
    markAppWindowAllClosed();
    app.quit();
});

app.on('quit', () => {
    markAppQuit();
});

const originalCheckForUpdates = checkForUpdates;
checkForUpdates = function wrappedCheckForUpdates() {
    markCheckForUpdatesEnter();
    try {
        return originalCheckForUpdates();
    } finally {
        markCheckForUpdatesLeave();
    }
};

const originalRunChecks = runChecks;
runChecks = async function wrappedRunChecks() {
    markRunChecksEntry();
    await markRunChecksStart();
    try {
        const result = await originalRunChecks();
        await markRunChecksDone(true);
        markRunChecksExit(true);
        return result;
    } catch (err) {
        await markRunChecksDone(false);
        markRunChecksExit(false);
        throw err;
    }
};

const originalLaunchApp = launchApp;
launchApp = function wrappedLaunchApp() {
    markLaunchAppStarted();
    try {
        const result = originalLaunchApp();
        markLaunchAppFinished();
        return result;
    } catch (err) {
        markLaunchAppFailed(err.message || String(err));
        throw err;
    }
};

markLogPhpReady();
startUpdateBeforeLicense();

app.on('activate', () => {
    ensureUpdateCheckStarted();
    flushPendingUpdateInfo();
});

setInterval(() => {
    if (isLicenseWindowOpen()) {
        flushPendingUpdateInfo();
    }
}, 4000);

setTimeout(() => {
    if (isLicenseWindowOpen() && !pendingUpdateMessage) {
        sendUpdateInfo('Güncelleme kontrol ediliyor...', 'Release bilgisi kontrol ediliyor...');
    }
}, 2500);

setInterval(() => {
    if (isLicenseWindowOpen()) {
        sendRemoteLicenseLog('license_window_periodic_state', {
            visible: true,
            pendingUpdateMessage,
            pendingUpdateLog
        });
    }
}, 10000);

setInterval(() => {
    if (isLicenseWindowOpen()) {
        sendLicenseDebugToWindow(statusSnapshot(), statusSnapshotType());
    }
}, 20000);

markFixRound('3.0.9-hotfix');
markCurrentFix('simplified license activation renderer and kept visible status feedback');
markWaitingForUserRetest();
