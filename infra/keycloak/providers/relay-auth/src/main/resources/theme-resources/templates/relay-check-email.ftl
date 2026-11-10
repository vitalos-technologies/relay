<#-- "Check your email" (D34): the email has a sign-in link (this browser) and a 6-digit code (type it here when the
     email opened on another device). Rendered through the active login theme's template.ftl. -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('code'); section>
    <#if section = "header">
        ${msg("relayCheckEmailTitle")}
    <#elseif section = "form">
        <p class="relay-lead" id="relay-sent">
            <#if relaySelfRegistration!false>${msg("relaySentBefore")} <strong>${relayEmail}</strong>${msg("relaySentAfter")}<#else>${msg("relaySentIfBefore")} <strong>${relayEmail}</strong> ${msg("relaySentIfAfter")}</#if>
        </p>
        <form id="relay-code-form" class="relay-form" action="${url.loginAction}" method="post" novalidate>
            <label for="code" class="relay-label">${msg("relayCodeLabel")}</label>
            <input id="code" name="code" type="text" class="relay-input relay-code" inputmode="numeric" autocomplete="one-time-code"
                   pattern="[0-9 ]*" maxlength="7" autofocus dir="ltr" placeholder="000000"
                   <#if messagesPerField.existsError('code')>aria-invalid="true" aria-describedby="input-error-code"</#if>>
            <#if messagesPerField.existsError('code')>
                <p id="input-error-code" class="relay-field-error" aria-live="polite">${kcSanitize(messagesPerField.get('code'))?no_esc}</p>
            </#if>
            <button id="relay-verify" name="verify" type="submit" class="relay-btn relay-btn-primary">${msg("relayVerify")}</button>
        </form>
        <div class="relay-row">
            <form action="${url.loginAction}" method="post"><button id="relay-resend" type="submit" name="resend" value="1" class="relay-link"<#if !(relayCanResend!true)> disabled</#if>>${msg("relayResend")}</button></form>
            <form action="${url.loginAction}" method="post"><button id="relay-restart" type="submit" name="relay_restart" value="1" class="relay-link">${msg("relayUseDifferentEmail")}</button></form>
        </div>
        <p class="relay-fine">${msg("relayCheckEmailHint", relayTtlMinutes!15)}</p>
    </#if>
</@layout.registrationLayout>
