<#-- Two-step verification prompt (authenticator app). Shown for Relay staff sign-in and for sensitive actions (step-up). -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>
    <#if section = "header">
        ${msg("relayOtpTitle")}
    <#elseif section = "form">
        <p class="relay-lead">${msg("relayOtpLead")}</p>
        <form id="kc-otp-login-form" class="relay-form" action="${url.loginAction}" method="post">
            <#if otpLogin.userOtpCredentials?size gt 1>
                <fieldset class="relay-group">
                    <legend class="relay-label">${msg("relayOtpWhichDevice")}</legend>
                    <#list otpLogin.userOtpCredentials as c>
                        <label class="relay-otp-choice"><input class="relay-otp-radio" type="radio" name="selectedCredentialId" value="${c.id}" <#if c.id == otpLogin.selectedCredentialId>checked</#if>> ${c.userLabel}</label>
                    </#list>
                </fieldset>
            </#if>
            <label for="otp" class="relay-label">${msg("loginOtpOneTime")}</label>
            <input id="otp" name="otp" type="text" class="relay-input relay-code" autocomplete="one-time-code" inputmode="numeric"
                   pattern="[0-9 ]*" maxlength="7" autofocus dir="ltr"
                   <#if messagesPerField.existsError('totp')>aria-invalid="true" aria-describedby="input-error-otp-code"</#if>>
            <#if messagesPerField.existsError('totp')>
                <p id="input-error-otp-code" class="relay-field-error" aria-live="polite">${kcSanitize(messagesPerField.get('totp'))?no_esc}</p>
            </#if>
            <button id="kc-login" name="login" type="submit" class="relay-btn relay-btn-primary">${msg("relayVerify")}</button>
        </form>
    </#if>
</@layout.registrationLayout>
