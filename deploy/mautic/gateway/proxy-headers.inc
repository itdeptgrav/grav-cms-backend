# Shared proxy headers for every allowlisted location.
#
# `Authorization` is forwarded deliberately: Mautic still authenticates and
# authorises every request. The gateway narrows what may be asked; it does not
# replace the provider's own check, and a gateway that stripped credentials
# would be granting access rather than restricting it.
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_read_timeout 30s;
proxy_connect_timeout 5s;

# The gateway never returns a provider error body for a request it refused —
# a refusal is answered before proxy_pass runs, so there is nothing upstream to
# quote.
proxy_intercept_errors off;
