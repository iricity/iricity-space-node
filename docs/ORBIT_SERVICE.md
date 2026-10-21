# Orbit Service

The orbit service turns published orbital elements into pass predictions for a declared site, and signs the result with the node's identity so anyone can verify where the numbers came from.

## Pipeline

```
CelesTrak GP (CCSDS OMM, JSON)  ->  SGP4 (satellite.js)  ->  passes over observer  ->  signed envelope (+ receipt when kept)
```

- **Elements.** `GET https://celestrak.org/NORAD/elements/gp.php?CATNR=<norad>&FORMAT=json` returns the current Orbit Mean-Elements Message. The connector caches it for `ELEMENTS_CACHE_TTL_MS` (default one hour), remembers a failed fetch for `ELEMENTS_NEGATIVE_CACHE_TTL_MS` (default five minutes) so repeated requests for an unreachable or unknown object do not become repeated upstream calls, and shares one in-flight fetch per object. A response whose `NORAD_CAT_ID` does not match the request is refused. When the network is unavailable it falls back to a bundled fixture. Every response states `elements_origin`: `live`, `cache` or `fixture`, and `elements_age_hours`, because stale elements degrade prediction accuracy by minutes per day.
- **Propagation.** SGP4 via `satellite.js` (`json2satrec` on the OMM). The implementation is `src/orbital/propagation.js`.
- **Pass search.** Coarse steps (default 30 s) over the window, bisection to one second at each horizon crossing. A pass is reported with acquisition (`aos`), time of closest approach (`tca`), loss (`los`), duration, maximum elevation, azimuths at `aos`, `tca`, `los`, and slant range at `tca`. `tca` is the best coarse sample, so it is quantised to the step. A window that opens with the object already above the threshold marks the first pass `truncated_at_window_start`; a pass still in progress when the window closes is marked `truncated_at_window_end`.
- **Signing.** The full prediction, including the OMM it was computed from, is wrapped in a `state-envelope/1` envelope under payload type `pass-prediction.json/1`, signed by the node's `did:key`. When the prediction is kept (operator route), a `state-receipt/1` receipt is added to the node's receipt chain and returned as `receipt`; otherwise `receipt` is `null`.

## Endpoints

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /passes` | public, rate limited | passes over the declared site; `norad_id`, `hours` (clamped to 48), `min_elevation_deg`, `start`, `fixture`; signed, never stored |
| `GET /orbital/passes` | operator key | any observer (`latitude`, `longitude`, `altitude_m`) or the declared site, `hours` up to 168; stores the signed prediction and issues a receipt |
| `GET /orbital/passes/history` | public | stored prediction summaries, filter by `norad_id` |
| `GET /orbital/passes/:prediction_id` | public | a stored prediction with its envelope and receipt verification |
| `GET /orbital/state` | operator key | ECI and geodetic state at `at`, plus look angles from an observer |
| `POST /envelopes/verify` | public, rate limited | verify any envelope offline |

Input rules, answered with `400`: `hours` must be a positive number (values above the route's ceiling are clamped, not rejected); `start` and `at` must be ISO-8601 and are read as UTC when they carry no zone; `latitude` and `longitude` must be given together, within range; `norad_id` must be a positive integer. A node with no declared site is `422` (`no_declared_site`). An object with no bundled elements when `fixture=true` is `404` (`elements_not_bundled`); a live fetch failure with no fallback is `502` (`elements_unavailable`).

`prediction_id` is derived from the node, the object, the elements hash, the observer coordinates, the window and the threshold, so two observers never share an id. `observer_id` is the node's id when its declared site was used and `null` for an ad-hoc observer; `observer_source` says which; `computed_by` names the node that signed.

## Verifying a prediction elsewhere

A prediction verifies without contacting the node:

```js
import { verifyEnvelope } from '@iricity/frontier-shared';
verifyEnvelope(prediction.envelope);   // { verified: true, signer: 'did:key:z6Mk…' }
```

The signer DID carries the public key. Compare it with `GET /identity` to confirm which node produced it.

## Accuracy notes

- Predictions use the declared site coordinates. Timing error from a kilometre of site error is well under a second; elevation error is a fraction of a degree.
- Element age matters more. SGP4 with elements a few days old is typically within tens of seconds for the ISS. The response reports the age so a consumer can decide.
- `min_elevation_deg` defaults to 10°, the usual threshold for a useful VHF/UHF contact from an urban site.

## Honest fallbacks

- No elements and no fixture: the request fails with a clear error. The node never invents elements.
- Elements that cannot be propagated to the requested time (a decayed object, or elements out of range) are a `422` with `code: propagation_failed` and the SGP4 error in the message, never an empty pass list. When the elements stop propagating partway through a window, the passes found so far are returned with `truncated_by_propagation_error` and `propagation_error`.
