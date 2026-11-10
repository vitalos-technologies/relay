<#-- Relay sign-in / sign-up page (D34): Continue with Google (when enabled) · or · email → Continue with email. -->
<#import "template.ftl" as layout>
<#assign signup = (relayMode!'') == 'signup'>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username'); section>
    <#if section = "header">
        <#if signup>${msg("relaySignupTitle")}<#else>${msg("relaySigninTitle")}</#if>
    <#elseif section = "form">
        <#if signup><p class="relay-lead">${msg("relaySignupLead")}</p></#if>
        <#if social?? && social.providers?has_content>
            <div class="relay-idps">
                <#list social.providers as p>
                    <a id="social-${p.alias}" class="relay-btn relay-btn-idp" href="${p.loginUrl}" data-once-link>
                        <#if p.providerId == "google">
                            <svg class="relay-idp-icon" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                        </#if>
                        <span>${msg("relayContinueWith", (p.displayName!p.alias))}</span>
                    </a>
                </#list>
            </div>
            <div class="relay-or" role="separator"><span>${msg("relayOr")}</span></div>
        </#if>
        <form id="kc-form-login" class="relay-form" action="${url.loginAction}" method="post" novalidate>
            <label for="username" class="relay-label">${msg("email")}</label>
            <input id="username" name="username" type="email" class="relay-input" value="${(login.username!'')}"
                   autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" autofocus required
                   placeholder="${msg('relayEmailPlaceholder')}"
                   <#if messagesPerField.existsError('username')>aria-invalid="true" aria-describedby="input-error-username"</#if>>
            <#if messagesPerField.existsError('username')>
                <p id="input-error-username" class="relay-field-error" aria-live="polite">${kcSanitize(messagesPerField.get('username'))?no_esc}</p>
            </#if>
            <button id="kc-login" name="login" type="submit" class="relay-btn relay-btn-primary">${msg("relayContinueWithEmail")}</button>
        </form>
        <p class="relay-fine">${msg("relayNoPassword")}</p>
    </#if>
</@layout.registrationLayout>
