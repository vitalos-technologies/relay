<#ftl output_format="plainText">
<#if relaySignup!false>${msg("relayEmailTitleSignup")}<#else>${msg("relayEmailTitle")}</#if>

${msg("relayEmailButton")}:
${relayLink}

${msg("relayEmailCodeLead")} ${relayCode}

${msg("relayEmailExpiry", relayTtlMinutes)}
${msg("relayEmailIgnore")}
