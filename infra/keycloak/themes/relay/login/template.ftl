<#-- Relay login layout (D34). Same macro signature as Keycloak's base template so every base page renders through it. -->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="relay" lang="${lang}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="color-scheme" content="light">
    <title><#if pageTitle??>${pageTitle} · Relay<#else>${msg("loginTitle",(realm.displayName!'Relay'))}</#if></title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.svg" type="image/svg+xml">
    <#if properties.styles?has_content><#list properties.styles?split(' ') as style><link href="${url.resourcesPath}/${style}" rel="stylesheet"></#list></#if>
    <#if properties.scripts?has_content><#list properties.scripts?split(' ') as script><script src="${url.resourcesPath}/${script}" type="text/javascript"></script></#list></#if>
    <#if scripts??><#list scripts as script><script src="${script}" type="text/javascript"></script></#list></#if>
    <script type="importmap">{ "imports": { "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js" } }</script>
    <script type="module">
        import { startSessionPolling } from "${url.resourcesPath}/js/authChecker.js";
        startSessionPolling("${url.ssoLoginInOtherTabsUrl?no_esc}");
    </script>
    <#if authenticationSession??>
    <script type="module">
        import { checkAuthSession } from "${url.resourcesPath}/js/authChecker.js";
        checkAuthSession("${authenticationSession.authSessionIdHash}");
    </script>
    </#if>
    <script type="module">
        // One click per provider button (no double submits).
        document.addEventListener("click", (e) => {
            const a = e.target.closest("a[data-once-link]");
            if (!a) return;
            if (a.getAttribute("aria-disabled") === "true") { e.preventDefault(); return; }
            a.setAttribute("aria-disabled", "true");
        });
    </script>
</head>
<body class="relay-body ${bodyClass}" data-page-id="login-${pageId}">
<main class="relay-shell">
    <div class="relay-brand">
        <#if (client.baseUrl)?has_content>
            <a href="${client.baseUrl}" class="relay-logo-link"><img class="relay-logo" src="${url.resourcesPath}/img/relay-logo.svg" alt="Relay" width="122" height="35"></a>
        <#else>
            <img class="relay-logo" src="${url.resourcesPath}/img/relay-logo.svg" alt="Relay" width="122" height="35">
        </#if>
    </div>
    <section class="relay-panel" aria-labelledby="kc-page-title">
        <h1 id="kc-page-title" class="relay-title"><#nested "header"></h1>
        <#if !(relayEmail??) && auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
            <#nested "show-username">
            <div id="kc-username" class="relay-user">
                <span id="kc-attempted-username">${auth.attemptedUsername}</span>
                <a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("relayNotYou")}</a>
            </div>
        </#if>
        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="relay-alert relay-alert-${message.type}" role="<#if message.type = 'error'>alert<#else>status</#if>">${kcSanitize(message.summary)?no_esc}</div>
        </#if>
        <#nested "form">
        <#if auth?has_content && auth.showTryAnotherWayLink()>
            <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" class="relay-row">
                <input type="hidden" name="tryAnotherWay" value="on">
                <button type="submit" class="relay-link" id="try-another-way">${msg("relayTryAnotherWay")}</button>
            </form>
        </#if>
        <#nested "socialProviders">
        <#if displayInfo><div id="kc-info" class="relay-info"><#nested "info"></div></#if>
    </section>
    <footer class="relay-foot">${msg("relayFooter")}</footer>
</main>
</body>
</html>
</#macro>
