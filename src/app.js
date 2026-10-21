import Fastify from "fastify";
import routes from "./routes.js";
import { getNodeIdentity } from "./identity.js";
import { getNodeDescription } from "./node.js";

/** Build the node's HTTP surface. Identity and self-description are resolved here, so a bad key or manifest fails at boot. */
export function buildApp({ logger = true } = {}) {
  const node = getNodeDescription();
  const identity = getNodeIdentity();
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });

  app.addHook("onRequest", (req, reply, done) => {
    reply.header("x-request-id", req.id);
    done();
  });
  app.addHook("onSend", (_req, reply, payload, done) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-node-id", node.node_id);
    done(null, payload);
  });

  app.setErrorHandler((error, req, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) req.log.error({ err: error }, "unhandled error");
    reply.code(status).send({ error: status >= 500 ? "unexpected error" : error.message, request_id: req.id });
  });

  app.register(routes);
  app.log.info({ node_id: identity.node_id, did: identity.did, signer_mode: identity.signer_mode, site: node.site }, "node ready");
  if (!identity.durable) app.log.warn(identity.warning);
  return app;
}
