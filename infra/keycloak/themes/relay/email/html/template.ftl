<#macro emailLayout>
<html lang="${locale.language!'en'}">
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f0f2d;">
<tr><td style="padding:0 0 24px;font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#F7631C;">Relay</td></tr>
<tr><td style="color:#0f0f2d;"><#nested></td></tr>
<tr><td style="border-top:1px solid #eceaf3;padding:16px 0 0;margin-top:24px;font-size:12px;color:#8a8ea3;">Relay · Create. Coordinate. Publish.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
</#macro>
