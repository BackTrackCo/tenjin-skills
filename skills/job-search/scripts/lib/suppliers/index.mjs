import * as jobs from './jobs.mjs';
import * as x from './x.mjs';
import * as careers from './careers.mjs';
import * as people from './people.mjs';
import * as linkedin from '../../../../loop-base/lib/suppliers/linkedin.mjs';
import * as linkedinHistory from '../../../../loop-base/lib/suppliers/linkedin-history.mjs';
import * as web from './websearch.mjs';
import { extendApp } from '../../../../loop-base/lib/app.mjs';
import { pickSupplier, pickTool, supplierTable } from '../../../../loop-base/lib/suppliers/registry.mjs';
import '../paths.mjs';
import * as eventsWeb from './events-web.mjs';
import * as eventsX from './events-x.mjs';
import * as eventsLinkedin from './events-linkedin.mjs';
import * as eventsPeople from './events-people.mjs';
import * as xHiringSearch from './x-hiring-search.mjs';
import * as eventsXSearch from './events-x-search.mjs';
import * as company from '../../../../loop-base/lib/suppliers/company.mjs';

// The supplier table is the loop base's registry: one mapper and one adapter per supplier, picked by the host the spec text names or by
// catalog tool id. This list is the only place a supplier host appears; it never appears in text people see.
export const SUPPLIERS = supplierTable([jobs, x, careers, people, linkedin, linkedinHistory, web.exa, eventsWeb, eventsX, eventsLinkedin, eventsPeople, xHiringSearch, eventsXSearch, company], web.adapter);
extendApp({ suppliers: SUPPLIERS });
export { pickSupplier, pickTool };
