package relay.keycloak;

import io.phasetwo.keycloak.magic.MagicLink;
import io.phasetwo.keycloak.magic.auth.token.MagicLinkActionToken;
import jakarta.ws.rs.core.MultivaluedHashMap;
import jakarta.ws.rs.core.MultivaluedMap;
import jakarta.ws.rs.core.Response;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.OptionalInt;
import java.util.regex.Pattern;
import org.jboss.logging.Logger;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.authenticators.browser.AbstractUsernameFormAuthenticator;
import org.keycloak.authentication.authenticators.util.AuthenticatorUtils;
import org.keycloak.common.util.SecretGenerator;
import org.keycloak.common.util.Time;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.events.Details;
import org.keycloak.events.Errors;
import org.keycloak.events.EventType;
import org.keycloak.forms.login.LoginFormsProvider;
import org.keycloak.models.AuthenticatorConfigModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.utils.FormMessage;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.sessions.AuthenticationSessionModel;

/**
 * Relay passwordless sign-in (D34): one email that carries BOTH a sign-in link and a 6-digit code.
 *
 * <ol>
 *   <li>Email step: the user types an email (Google, when enabled, is offered on the same page by the login theme).</li>
 *   <li>A 6-digit code is generated and only its salted SHA-256 is kept in the authentication session; a single-use
 *       sign-in link is created with Phase Two's keycloak-magic-link action token ({@link MagicLink}), whose handler
 *       (shipped by that extension) signs the clicking browser in. Both go out in ONE email.</li>
 *   <li>"Check your email" page: the link works in the browser that started sign-in; the code is for when the email is
 *       opened on another device (type it here).</li>
 * </ol>
 *
 * Unknown emails: an account is created only when the realm allows self-registration; otherwise nothing is sent and the
 * page looks the same (no account enumeration). Codes expire (default 15 min), allow 5 tries, then need a new email;
 * 3 emails per sign-in attempt; wrong codes count towards the realm's brute-force lockout.
 */
public class EmailSignInAuthenticator implements Authenticator {

  private static final Logger log = Logger.getLogger(EmailSignInAuthenticator.class);

  static final String CFG_TTL = "relay.ttl.seconds";
  static final int DEFAULT_TTL = 900;
  static final int MAX_ATTEMPTS = 5;
  static final int MAX_SENDS = 3;

  static final String NOTE_EMAIL = "relay.email";
  static final String NOTE_USER = "relay.user";
  static final String NOTE_CODE_HASH = "relay.code.hash";
  static final String NOTE_CODE_EXP = "relay.code.exp";
  static final String NOTE_ATTEMPTS = "relay.code.attempts";
  static final String NOTE_SENDS = "relay.code.sends";
  static final String NOTE_SEND_FAILED = "relay.send.failed";

  /** Extra authorization parameter (?relay_mode=signup) → Keycloak keeps it as this client note. */
  static final String MODE_NOTE = "client_request_param_relay_mode";

  private static final Pattern EMAIL = Pattern.compile("^[^@\\s]{1,64}@[^@\\s]+\\.[^@\\s]{2,}$");

  @Override
  public void authenticate(AuthenticationFlowContext context) {
    AuthenticationSessionModel as = context.getAuthenticationSession();
    if (as.getAuthNote(NOTE_EMAIL) != null) {
      context.challenge(checkEmailPage(context, null, null));
      return;
    }
    // A login_hint (e.g. a step-up for a known user) only pre-fills the field; nothing is sent until the user asks.
    String hint = as.getClientNote(OIDCLoginProtocol.LOGIN_HINT_PARAM);
    context.challenge(emailPage(context, hint == null || hint.isBlank() ? null : hint, null));
  }

  @Override
  public void action(AuthenticationFlowContext context) {
    AuthenticationSessionModel as = context.getAuthenticationSession();
    MultivaluedMap<String, String> form = context.getHttpRequest().getDecodedFormParameters();

    if (form.containsKey("relay_restart")) {
      clearNotes(as);
      context.clearUser();
      context.challenge(emailPage(context, null, null));
      return;
    }
    if (as.getAuthNote(NOTE_EMAIL) != null) {
      if (form.containsKey("resend")) resend(context);
      else verifyCode(context, form.getFirst("code"));
      return;
    }

    // Email step.
    String raw = form.getFirst("username");
    String email = raw == null ? null : raw.trim().toLowerCase(Locale.ROOT);
    if (email == null || email.length() > 254 || !EMAIL.matcher(email).matches()) {
      context.challenge(emailPage(context, raw, "relayInvalidEmail"));
      return;
    }
    KeycloakSession session = context.getSession();
    RealmModel realm = context.getRealm();
    UserModel user = KeycloakModelUtils.findUserByNameOrEmail(session, realm, email);
    if (user == null && realm.isRegistrationAllowed()) {
      user = session.users().addUser(realm, email);
      user.setEnabled(true);
      user.setEmail(email);
      context.newEvent().event(EventType.REGISTER).user(user).detail(Details.EMAIL, email)
          .detail(Details.REGISTER_METHOD, "relay-email").success();
    }
    as.setAuthNote(NOTE_EMAIL, email);
    as.setAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME, email);
    if (user != null && user.isEnabled() && AuthenticatorUtils.getDisabledByBruteForceEventError(context, user) == null) {
      as.setAuthNote(NOTE_USER, user.getId());
      context.setUser(user);
      issueAndSend(context, user);
    } else {
      log.debugf("relay-email-sign-in: no usable account for the address entered; nothing sent");
      as.setAuthNote(NOTE_SENDS, "1");
    }
    context.challenge(checkEmailPage(context, null, null));
  }

  private void resend(AuthenticationFlowContext context) {
    AuthenticationSessionModel as = context.getAuthenticationSession();
    int sends = intNote(as, NOTE_SENDS);
    if (sends >= MAX_SENDS) {
      context.challenge(checkEmailPage(context, "relayResendLimit", null));
      return;
    }
    UserModel user = noteUser(context);
    if (user != null && user.isEnabled()) issueAndSend(context, user);
    else {
      as.setAuthNote(NOTE_SENDS, String.valueOf(sends + 1));
      as.setAuthNote(NOTE_ATTEMPTS, "0");
    }
    context.challenge(checkEmailPage(context, null, "relayCodeResent"));
  }

  private void verifyCode(AuthenticationFlowContext context, String code) {
    AuthenticationSessionModel as = context.getAuthenticationSession();
    UserModel user = noteUser(context);
    if (user != null) {
      String bf = AuthenticatorUtils.getDisabledByBruteForceEventError(context, user);
      if (bf != null) {
        context.getEvent().user(user).error(bf);
        context.challenge(checkEmailPage(context, "relayLockedOut", null));
        return;
      }
    }
    String hash = as.getAuthNote(NOTE_CODE_HASH);
    long exp = longNote(as, NOTE_CODE_EXP);
    String typed = code == null ? "" : code.replaceAll("\\s", "");
    if (user == null) {
      // No account for this address (nothing was sent): answer exactly like a wrong code, so the page never tells whether
      // an account exists — wrong, wrong, … too many tries, then "expired, send a new code".
      int tries = intNote(as, NOTE_ATTEMPTS) + 1;
      as.setAuthNote(NOTE_ATTEMPTS, String.valueOf(tries));
      String msg = tries > MAX_ATTEMPTS ? "relayCodeExpired" : tries == MAX_ATTEMPTS ? "relayTooManyAttempts" : "relayWrongCode";
      context.challenge(checkEmailPage(context, msg, null));
      return;
    }
    if (hash == null || Time.currentTime() > exp) {
      context.challenge(checkEmailPage(context, intNote(as, NOTE_SENDS) >= MAX_SENDS ? "relayResendLimit" : "relayCodeExpired", null));
      return;
    }
    int attempts = intNote(as, NOTE_ATTEMPTS) + 1;
    as.setAuthNote(NOTE_ATTEMPTS, String.valueOf(attempts));
    boolean match = typed.matches("\\d{6}")
        && MessageDigest.isEqual(hash.getBytes(StandardCharsets.US_ASCII), hashCode(as, typed).getBytes(StandardCharsets.US_ASCII));
    if (match && user.isEnabled()) {
      clearNotes(as);
      user.setEmailVerified(true);
      context.setUser(user);
      context.success();
      return;
    }
    if (attempts >= MAX_ATTEMPTS) as.removeAuthNote(NOTE_CODE_HASH);
    String msg = attempts >= MAX_ATTEMPTS ? "relayTooManyAttempts" : "relayWrongCode";
    context.getEvent().user(user).event(EventType.LOGIN_ERROR).error(Errors.INVALID_CODE);
    context.failureChallenge(AuthenticationFlowError.INVALID_CREDENTIALS, checkEmailPage(context, msg, null));
  }

  /** New code + new single-use link, one email. Returns false when the email could not be sent. */
  private boolean issueAndSend(AuthenticationFlowContext context, UserModel user) {
    AuthenticationSessionModel as = context.getAuthenticationSession();
    KeycloakSession session = context.getSession();
    RealmModel realm = context.getRealm();
    int ttl = ttl(context);
    String code = SecretGenerator.getInstance().randomString(6, SecretGenerator.DIGITS);
    as.setAuthNote(NOTE_CODE_HASH, hashCode(as, code));
    as.setAuthNote(NOTE_CODE_EXP, String.valueOf(Time.currentTime() + ttl));
    as.setAuthNote(NOTE_ATTEMPTS, "0");
    as.setAuthNote(NOTE_SENDS, String.valueOf(intNote(as, NOTE_SENDS) + 1));
    as.removeAuthNote(NOTE_SEND_FAILED);

    String clientId = as.getClient().getClientId();
    // Single use (not reusable), same lifetime as the code. The token carries this request's redirect_uri, state, nonce
    // and PKCE challenge, so the app still requires its own login-binding cookie: the link completes sign-in only in the
    // browser that started it, and the code covers the other-device case.
    MagicLinkActionToken token = MagicLink.createActionToken(user, clientId, OptionalInt.of(ttl), Boolean.FALSE, as, Boolean.FALSE);
    String link = MagicLink.linkFromActionToken(session, realm, token);

    Map<String, Object> attrs = new HashMap<>();
    attrs.put("relayLink", link);
    attrs.put("relayCode", code);
    attrs.put("relayTtlMinutes", Math.max(1, ttl / 60));
    attrs.put("relayEmail", user.getEmail());
    attrs.put("relaySignup", isSignup(as));
    try {
      session.getProvider(EmailTemplateProvider.class)
          .setRealm(realm)
          .setUser(user)
          .setAuthenticationSession(as)
          .send("relaySignInSubject", List.of(code), "relay-sign-in.ftl", attrs);
      context.newEvent().event(EventType.SEND_VERIFY_EMAIL).user(user).detail(Details.EMAIL, user.getEmail())
          .detail("method", "relay-email-sign-in").success();
      return true;
    } catch (EmailException e) {
      log.warnf("relay-email-sign-in: could not send the sign-in email (%s)", e.getClass().getSimpleName());
      as.setAuthNote(NOTE_SEND_FAILED, "true");
      context.newEvent().event(EventType.SEND_VERIFY_EMAIL_ERROR).user(user).error(Errors.EMAIL_SEND_FAILED);
      return false;
    }
  }

  private Response emailPage(AuthenticationFlowContext context, String prefill, String error) {
    LoginFormsProvider f = context.form();
    common(context, f);
    if (prefill != null) {
      MultivaluedMap<String, String> form = new MultivaluedHashMap<>();
      form.add("username", prefill.trim());
      f.setFormData(form);
    }
    if (error != null) f.addError(new FormMessage("username", error));
    return f.createLoginUsername();
  }

  private Response checkEmailPage(AuthenticationFlowContext context, String error, String info) {
    AuthenticationSessionModel as = context.getAuthenticationSession();
    LoginFormsProvider f = context.form().setExecution(context.getExecution().getId());
    common(context, f);
    f.setAttribute("relayEmail", as.getAuthNote(NOTE_EMAIL));
    f.setAttribute("relayTtlMinutes", Math.max(1, ttl(context) / 60));
    f.setAttribute("relayCanResend", intNote(as, NOTE_SENDS) < MAX_SENDS);
    if ("true".equals(as.getAuthNote(NOTE_SEND_FAILED))) f.addError(new FormMessage(null, "relaySendFailed"));
    else if (error != null) f.addError(new FormMessage("code", error));
    if (info != null && error == null) f.setInfo(info);
    return f.createForm("relay-check-email.ftl");
  }

  private void common(AuthenticationFlowContext context, LoginFormsProvider f) {
    f.setAttribute("relayMode", isSignup(context.getAuthenticationSession()) ? "signup" : "signin");
    f.setAttribute("relaySelfRegistration", context.getRealm().isRegistrationAllowed());
  }

  private static boolean isSignup(AuthenticationSessionModel as) {
    return "signup".equals(as.getClientNote(MODE_NOTE));
  }

  private UserModel noteUser(AuthenticationFlowContext context) {
    String id = context.getAuthenticationSession().getAuthNote(NOTE_USER);
    return id == null ? null : context.getSession().users().getUserById(context.getRealm(), id);
  }

  private static int ttl(AuthenticationFlowContext context) {
    AuthenticatorConfigModel cfg = context.getAuthenticatorConfig();
    if (cfg != null && cfg.getConfig() != null) {
      try {
        int v = Integer.parseInt(cfg.getConfig().getOrDefault(CFG_TTL, String.valueOf(DEFAULT_TTL)));
        if (v >= 60 && v <= 3600) return v;
      } catch (NumberFormatException ignored) {
        // fall through to the default
      }
    }
    return DEFAULT_TTL;
  }

  private static String hashCode(AuthenticationSessionModel as, String code) {
    try {
      MessageDigest d = MessageDigest.getInstance("SHA-256");
      d.update((as.getParentSession().getId() + ":" + as.getTabId() + ":" + code).getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(d.digest());
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static void clearNotes(AuthenticationSessionModel as) {
    for (String n : new String[] {NOTE_EMAIL, NOTE_USER, NOTE_CODE_HASH, NOTE_CODE_EXP, NOTE_ATTEMPTS, NOTE_SENDS, NOTE_SEND_FAILED}) {
      as.removeAuthNote(n);
    }
    as.removeAuthNote(AbstractUsernameFormAuthenticator.ATTEMPTED_USERNAME);
  }

  private static int intNote(AuthenticationSessionModel as, String n) {
    try {
      String v = as.getAuthNote(n);
      return v == null ? 0 : Integer.parseInt(v);
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  private static long longNote(AuthenticationSessionModel as, String n) {
    try {
      String v = as.getAuthNote(n);
      return v == null ? 0L : Long.parseLong(v);
    } catch (NumberFormatException e) {
      return 0L;
    }
  }

  @Override
  public boolean requiresUser() {
    return false;
  }

  @Override
  public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
    return true;
  }

  @Override
  public void setRequiredActions(KeycloakSession session, RealmModel realm, UserModel user) {}

  @Override
  public void close() {}
}
