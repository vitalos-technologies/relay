package relay.keycloak;

import java.util.List;
import org.keycloak.Config;
import org.keycloak.authentication.Authenticator;
import org.keycloak.authentication.AuthenticatorFactory;
import org.keycloak.models.AuthenticationExecutionModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.provider.ProviderConfigProperty;

public class EmailSignInAuthenticatorFactory implements AuthenticatorFactory {

  public static final String PROVIDER_ID = "relay-email-sign-in";
  private static final EmailSignInAuthenticator SINGLETON = new EmailSignInAuthenticator();
  private static final AuthenticationExecutionModel.Requirement[] REQUIREMENTS = {
    AuthenticationExecutionModel.Requirement.REQUIRED,
    AuthenticationExecutionModel.Requirement.ALTERNATIVE,
    AuthenticationExecutionModel.Requirement.DISABLED,
  };

  @Override
  public String getId() {
    return PROVIDER_ID;
  }

  @Override
  public Authenticator create(KeycloakSession session) {
    return SINGLETON;
  }

  @Override
  public String getDisplayType() {
    return "Relay email sign-in (link + code)";
  }

  @Override
  public String getReferenceCategory() {
    return "email";
  }

  @Override
  public boolean isConfigurable() {
    return true;
  }

  @Override
  public AuthenticationExecutionModel.Requirement[] getRequirementChoices() {
    return REQUIREMENTS;
  }

  @Override
  public boolean isUserSetupAllowed() {
    return false;
  }

  @Override
  public String getHelpText() {
    return "Sends one email with a single-use sign-in link (Phase Two magic-link action token) and a 6-digit code.";
  }

  @Override
  public List<ProviderConfigProperty> getConfigProperties() {
    ProviderConfigProperty ttl = new ProviderConfigProperty();
    ttl.setName(EmailSignInAuthenticator.CFG_TTL);
    ttl.setLabel("Link and code lifetime (seconds)");
    ttl.setType(ProviderConfigProperty.STRING_TYPE);
    ttl.setDefaultValue(String.valueOf(EmailSignInAuthenticator.DEFAULT_TTL));
    ttl.setHelpText("60-3600. Default 900 (15 minutes).");
    // Read by Keycloak's "Authentication Method Reference (AMR)" protocol mapper.
    ProviderConfigProperty amr = new ProviderConfigProperty();
    amr.setName("default.reference.value");
    amr.setLabel("AMR value");
    amr.setType(ProviderConfigProperty.STRING_TYPE);
    ProviderConfigProperty amrAge = new ProviderConfigProperty();
    amrAge.setName("default.reference.maxAge");
    amrAge.setLabel("AMR max age (seconds)");
    amrAge.setType(ProviderConfigProperty.STRING_TYPE);
    return List.of(ttl, amr, amrAge);
  }

  @Override
  public void init(Config.Scope config) {}

  @Override
  public void postInit(KeycloakSessionFactory factory) {}

  @Override
  public void close() {}
}
