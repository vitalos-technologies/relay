# Relay sign-in server image (D34): Keycloak 26.4 + passwordless email sign-in + the Relay login/email theme.
# Used by the dev stack (infra/compose.yaml) and the Oracle kit (infra/oracle/compose.prod.yaml); build context = this folder.
#
#  - Phase Two keycloak-magic-link, pinned and checksum-verified (single-use sign-in link action token + its handler).
#    Licence: Elastic License 2.0 (source available; NOT an OSI open-source licence). Self-hosting it as part of Relay's
#    own sign-in is within the licence; offering Keycloak/the extension to others as a hosted service is not.
#    Source: https://github.com/p2-inc/keycloak-magic-link (tag v0.52), artefact from Maven Central.
#  - relay-auth (providers/relay-auth, compiled here against this exact Keycloak's jars): one email with BOTH the link and a
#    6-digit code; Google first sign-in links an existing account only on a provider-verified email.
#  - themes/relay: the Relay-branded login and email theme.
# The jars are architecture-independent; the image builds the same on arm64 (Oracle Ampere) and amd64.
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.4
ARG JDK_IMAGE=eclipse-temurin:21-jdk

FROM ${KEYCLOAK_IMAGE} AS keycloak

FROM ${JDK_IMAGE} AS providers
# Pinned extension release (built against Keycloak 26.3; the last line before the 26.5 rebuild — verified on 26.4.7).
ARG MAGIC_LINK_VERSION=0.52
ARG MAGIC_LINK_SHA256=f2bd0dc3880e434ad1731a40decbc181a1d68a5071dacf5369b40ec14078b4d4
ADD https://repo1.maven.org/maven2/io/phasetwo/keycloak/keycloak-magic-link/${MAGIC_LINK_VERSION}/keycloak-magic-link-${MAGIC_LINK_VERSION}.jar /ext/keycloak-magic-link.jar
RUN echo "${MAGIC_LINK_SHA256}  /ext/keycloak-magic-link.jar" | sha256sum -c - \
 || { echo "keycloak-magic-link ${MAGIC_LINK_VERSION}: checksum mismatch, refusing to build" >&2; exit 1; }
COPY --from=keycloak /opt/keycloak/lib/lib /kc
COPY providers/relay-auth/src/main /src
RUN set -eu; mkdir -p /out; \
    javac --release 17 -nowarn -d /out -cp "/kc/main/*:/kc/boot/*:/ext/keycloak-magic-link.jar" $(find /src/java -name '*.java'); \
    cp -r /src/resources/. /out/; \
    jar --create --file /ext/relay-auth.jar -C /out .

FROM ${KEYCLOAK_IMAGE}
COPY --from=providers --chown=keycloak:keycloak /ext/keycloak-magic-link.jar /ext/relay-auth.jar /opt/keycloak/providers/
COPY --chown=keycloak:keycloak themes/relay /opt/keycloak/themes/relay
# Pre-build for production (PostgreSQL, health endpoints) so `start` does not re-augment on every boot.
# `start-dev` (local stack) rebuilds for its own settings automatically.
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true
