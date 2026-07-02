import { IsBoolean, IsOptional, IsUrl, MaxLength } from "class-validator";
import { Environment } from "@server/env";
import { Public } from "@server/utils/decorators/Public";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class OIDCPluginEnvironment extends Environment {
  /**
   * OIDC client credentials. To enable authentication with any
   * compatible provider.
   */
  @IsOptional()
  @CannotUseWithout("OIDC_CLIENT_SECRET")
  public OIDC_CLIENT_ID = this.toOptionalString(environment.OIDC_CLIENT_ID);

  @IsOptional()
  @CannotUseWithout("OIDC_CLIENT_ID")
  public OIDC_CLIENT_SECRET = this.toOptionalString(
    environment.OIDC_CLIENT_SECRET
  );

  /**
   * The OIDC issuer URL for automatic discovery of endpoints via the
   * well-known configuration endpoint. When provided, the authorization,
   * token, and userinfo endpoints will be automatically discovered.
   */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    allow_underscores: true,
  })
  public OIDC_ISSUER_URL = this.toOptionalString(environment.OIDC_ISSUER_URL);

  /**
   * The name of the OIDC provider, eg "GitLab" – this will be displayed on the
   * sign-in button and other places in the UI. The default value is:
   * "OpenID Connect".
   */
  @MaxLength(50)
  public OIDC_DISPLAY_NAME = environment.OIDC_DISPLAY_NAME ?? "OpenID Connect";

  /**
   * The OIDC authorization endpoint.
   */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    allow_underscores: true,
  })
  public OIDC_AUTH_URI = this.toOptionalString(environment.OIDC_AUTH_URI);

  /**
   * The OIDC token endpoint.
   */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    allow_underscores: true,
  })
  public OIDC_TOKEN_URI = this.toOptionalString(environment.OIDC_TOKEN_URI);

  /**
   * The OIDC userinfo endpoint.
   */
  @IsOptional()
  @IsUrl({
    require_tld: false,
    allow_underscores: true,
  })
  public OIDC_USERINFO_URI = this.toOptionalString(
    environment.OIDC_USERINFO_URI
  );

  /**
   * The OIDC profile field to use as the username. The default value is
   * "preferred_username".
   */
  public OIDC_USERNAME_CLAIM =
    environment.OIDC_USERNAME_CLAIM ?? "preferred_username";

  /**
   * The OIDC claim to read the user's group membership from, supporting dotted
   * paths (eg "groups", "roles", "custom.groups"). When set, group-based tenant
   * isolation is enabled: each group the user belongs to is mapped to its own
   * Outline workspace. The claim must be included in the userinfo response or
   * id_token, so remember to request the relevant scope via OIDC_SCOPES.
   */
  public OIDC_GROUP_CLAIM = this.toOptionalString(
    environment.OIDC_GROUP_CLAIM
  );

  /**
   * When true, a user that authenticates without any group in the configured
   * OIDC_GROUP_CLAIM is denied access rather than falling back to the legacy,
   * unisolated per-domain workspace. Only meaningful when OIDC_GROUP_CLAIM is
   * set.
   */
  @IsOptional()
  @IsBoolean()
  public OIDC_REQUIRE_GROUP = this.toOptionalBoolean(
    environment.OIDC_REQUIRE_GROUP
  );

  /**
   * A space separated list of OIDC scopes to request. Defaults to "openid
   * profile email".
   */
  public OIDC_SCOPES = environment.OIDC_SCOPES ?? "openid profile email";

  /**
   * Disable autoredirect to the OIDC login page if there is only one
   * authentication method and that method is OIDC.
   */
  @Public
  @IsOptional()
  @IsBoolean()
  public OIDC_DISABLE_REDIRECT = this.toOptionalBoolean(
    environment.OIDC_DISABLE_REDIRECT
  );

  /**
   * The OIDC logout endpoint.
   */
  @Public
  @IsOptional()
  @IsUrl({
    require_tld: false,
    allow_underscores: true,
  })
  public OIDC_LOGOUT_URI = this.toOptionalString(environment.OIDC_LOGOUT_URI);
}

export default new OIDCPluginEnvironment();
