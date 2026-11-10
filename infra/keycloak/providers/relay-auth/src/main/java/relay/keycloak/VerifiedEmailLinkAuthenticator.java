package relay.keycloak;

import jakarta.ws.rs.core.Response;
import java.util.Map;
import org.jboss.logging.Logger;
import org.keycloak.authentication.AuthenticationFlowContext;
import org.keycloak.authentication.AuthenticationFlowError;
import org.keycloak.authentication.authenticators.broker.AbstractIdpAuthenticator;
import org.keycloak.authentication.authenticators.broker.util.SerializedBrokeredIdentityContext;
import org.keycloak.broker.provider.BrokeredIdentityContext;
import org.keycloak.events.Errors;
import org.keycloak.jose.jws.JWSInput;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.representations.IDToken;
import org.keycloak.representations.JsonWebToken;

/**
 * First sign-in with an external identity provider (Google), Relay rules (D34):
 * <ul>
 *   <li>An existing Relay account with the same email is linked ONLY when the provider's verified ID token says
 *       {@code email_verified: true} (no account takeover through an unverified address).</li>
 *   <li>A new email continues to the next alternative (create user) only when the realm allows self-registration —
 *       the same rule as email sign-up; otherwise the person is told there is no Relay account for that email.</li>
 * </ul>
 */
public class VerifiedEmailLinkAuthenticator extends AbstractIdpAuthenticator {

  private static final Logger log = Logger.getLogger(VerifiedEmailLinkAuthenticator.class);

  @Override
  protected void authenticateImpl(AuthenticationFlowContext context, SerializedBrokeredIdentityContext serialCtx, BrokeredIdentityContext broker) {
    KeycloakSession session = context.getSession();
    RealmModel realm = context.getRealm();
    String email = broker.getEmail() == null ? null : broker.getEmail().trim();
    if (email == null || email.isEmpty()) {
      deny(context, "relayIdpNoEmail");
      return;
    }
    UserModel existing = session.users().getUserByEmail(realm, email);
    if (existing == null) {
      if (realm.isRegistrationAllowed()) {
        context.attempted(); // next alternative creates the account
        return;
      }
      deny(context, "relayIdpNoAccount");
      return;
    }
    if (!emailVerifiedByProvider(broker)) {
      log.debugf("relay-idp-verified-email-link: provider did not report a verified email; not linking");
      deny(context, "relayIdpEmailNotVerified");
      return;
    }
    if (!existing.isEnabled()) {
      deny(context, "accountDisabledMessage");
      return;
    }
    context.setUser(existing);
    context.success();
  }

  @Override
  protected void actionImpl(AuthenticationFlowContext context, SerializedBrokeredIdentityContext serialCtx, BrokeredIdentityContext broker) {}

  static boolean emailVerifiedByProvider(BrokeredIdentityContext broker) {
    Map<String, Object> data = broker.getContextData();
    if (data == null) return false;
    Object validated = data.get("VALIDATED_ID_TOKEN");
    if (validated instanceof IDToken id && id.getEmailVerified() != null) return id.getEmailVerified();
    if (validated instanceof JsonWebToken jwt && jwt.getOtherClaims() != null) {
      Object v = jwt.getOtherClaims().get("email_verified");
      if (v != null) return Boolean.parseBoolean(String.valueOf(v));
    }
    // The raw ID token Keycloak validated at the broker endpoint (kept server-side in the authentication session).
    Object raw = data.get("FEDERATED_ID_TOKEN");
    if (raw instanceof String s && !s.isBlank()) {
      try {
        IDToken t = new JWSInput(s).readJsonContent(IDToken.class);
        return Boolean.TRUE.equals(t.getEmailVerified());
      } catch (Exception e) {
        log.debugf("relay-idp-verified-email-link: could not read the provider ID token (%s)", e.getClass().getSimpleName());
      }
    }
    return false;
  }

  private void deny(AuthenticationFlowContext context, String message) {
    context.getEvent().error(Errors.INVALID_USER);
    Response page = context.form().setError(message).createErrorPage(Response.Status.FORBIDDEN);
    context.failureChallenge(AuthenticationFlowError.ACCESS_DENIED, page);
  }

  @Override
  public boolean requiresUser() {
    return false;
  }

  @Override
  public boolean configuredFor(KeycloakSession session, RealmModel realm, UserModel user) {
    return true;
  }
}
