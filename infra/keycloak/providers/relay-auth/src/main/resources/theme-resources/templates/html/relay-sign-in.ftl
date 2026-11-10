<#-- Sign-in email (D34): one email, a sign-in button AND a 6-digit code. Self-contained HTML (inline styles, no images). -->
<html lang="${locale.language!'en'}">
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f0f2d;">
<tr><td style="padding:0 0 28px;font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#F7631C;">Relay</td></tr>
<tr><td style="padding:0 0 8px;font-size:22px;line-height:1.3;font-weight:600;color:#0f0f2d;"><#if relaySignup!false>${msg("relayEmailTitleSignup")}<#else>${msg("relayEmailTitle")}</#if></td></tr>
<tr><td style="padding:0 0 24px;font-size:15px;line-height:1.6;color:#555a70;">${msg("relayEmailLead")}</td></tr>
<tr><td style="padding:0 0 28px;">
  <a href="${relayLink}" style="display:inline-block;background:#3b1f8f;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;line-height:1;padding:14px 22px;border-radius:10px;">${msg("relayEmailButton")}</a>
</td></tr>
<tr><td style="padding:0 0 8px;font-size:14px;line-height:1.6;color:#555a70;">${msg("relayEmailCodeLead")}</td></tr>
<tr><td style="padding:0 0 28px;">
  <div style="display:inline-block;background:#f5f3fb;border:1px solid #eceaf3;border-radius:10px;padding:12px 18px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:28px;font-weight:600;letter-spacing:0.28em;color:#0f0f2d;">${relayCode}</div>
</td></tr>
<tr><td style="padding:0 0 8px;font-size:13px;line-height:1.6;color:#555a70;">${msg("relayEmailExpiry", relayTtlMinutes)}</td></tr>
<tr><td style="padding:0 0 28px;font-size:13px;line-height:1.6;color:#555a70;">${msg("relayEmailIgnore")}</td></tr>
<tr><td style="border-top:1px solid #eceaf3;padding:16px 0 0;font-size:12px;line-height:1.6;color:#8a8ea3;">${msg("relayEmailFooter")}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
