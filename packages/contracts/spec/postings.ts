import type { Route, Schema } from "./shared.ts";
import {
  get, post, patch, del, ok, okPage, okList, obj, arr, str, int, num, bool, uuid, dateTime, date, any, nullable, ref, enumOf,
  body, pathParam, query, pageParams, noContent, binary,
} from "./shared.ts";

const jobCategory = enumOf("dev", "data", "design", "plan", "marketing", "sales", "hr", "ops");
const employmentType = enumOf("full_time", "contract", "intern", "freelance", "dispatch");
const postingStatus = enumOf("DRAFT", "OPEN", "CLOSED");
const applicationStage = enumOf("DISCOVERED", "PREPARING", "READY", "APPLIED", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED", "REJECTED", "WITHDRAWN");
const csv = (description: string): Schema => ({ type: "string", description });
const imageKey: Schema = { type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$", description: "Key returned by the image upload endpoint; null or empty clears it" };
const sourceUrl: Schema = { type: ["string", "null"], format: "uri", minLength: 1, maxLength: 2000, description: "http(s) URL without credentials" };
const textList = (maxItems: number, maxLength: number): Schema => ({ type: "array", maxItems, items: { type: "string", minLength: 1, maxLength } });
const careerYears: Schema = { type: "integer", minimum: 0, maximum: 80 };
const facetItem = obj({ id: str, count: int });

const filterParams = (withLocation: boolean): Schema[] => [
  query("q", { type: "string", maxLength: 200 }, "Matches title or company (Hangul choseong/jamo aware)"),
  query("category", csv("Comma-separated job categories: dev, data, design, plan, marketing, sales, hr, ops")),
  query("skills", csv("Comma-separated skill names (each at most 40 characters); matches any")),
  query("careerYears", csv("Comma-separated career buckets: 0, 1-3, 4-6, 7-9, 10+")),
  ...(withLocation ? [query("location", csv("Comma-separated locations (each at most 80 characters); a region also matches its sub-areas (\"서울\" matches \"서울 강남구\")"))] : []),
  query("employmentType", csv("Comma-separated employment types: full_time, contract, intern, freelance, dispatch")),
];

const requiredQuery = (name: string, schema: Schema, description: string): Schema => ({ name, in: "query", required: true, schema, description });

const postingWriteFields: Record<string, Schema> = {
  title: { type: "string", minLength: 1, maxLength: 300 },
  company: { type: "string", minLength: 1, maxLength: 200, description: "Defaults to the verified company name on create" },
  jobCategory,
  careerMin: careerYears,
  careerMax: { type: ["integer", "null"], minimum: 0, maximum: 80, description: "Must be >= careerMin" },
  location: { type: "string", minLength: 1, maxLength: 80 },
  employmentType,
  description: { type: "string", minLength: 1, maxLength: 50000 },
  skills: textList(30, 40),
  requirements: textList(50, 500),
  preferred: textList(50, 500),
  workConditions: { type: ["object", "null"], additionalProperties: true },
  imageKey,
  sourceUrl,
  deadline: nullable(date),
  status: enumOf("DRAFT", "OPEN"),
};

export const routes: Route[] = [
  get("core", "/api/v1/postings", {
    tag: "postings",
    summary: "List open postings",
    auth: "optional",
    description: "Only OPEN, not closed postings. The cursor only applies to sort=latest; deadline and popular ignore it. page.total is included.",
    params: [
      ...pageParams,
      query("sort", { type: "string", enum: ["latest", "deadline", "popular"], default: "latest" }),
      query("deadlineWithin", enumOf("7"), "Only postings whose deadline falls within the next 7 days"),
      ...filterParams(true),
    ],
    responses: { 200: okPage(ref("Posting")) },
  }),
  post("core", "/api/v1/postings", {
    tag: "postings",
    summary: "Create a posting",
    description: "Requires membership in a verified company (403 otherwise). Response includes member fields (status, applicantCount, newApplicantCount, createdBy).",
    body: body(obj(postingWriteFields, ["title", "jobCategory", "careerMin", "location", "employmentType", "description"])),
    responses: { 201: ok(ref("PostingDetail"), "Created") },
  }),
  get("core", "/api/v1/postings/facets", {
    tag: "postings",
    summary: "Filter facet counts for open postings",
    auth: "optional",
    description: "Each facet ignores its own filter (career ignores careerYears, category ignores category, skills ignores skills); location ignores location. category lists every category, location and skills only non-zero ones.",
    params: filterParams(true),
    responses: { 200: ok(obj({ career: arr(facetItem), category: arr(facetItem), location: arr(facetItem), skills: arr(facetItem) })) },
  }),
  get("core", "/api/v1/postings/locations", {
    tag: "postings",
    summary: "Open posting counts by location",
    auth: "optional",
    params: filterParams(false),
    responses: { 200: okList(obj({ location: str, count: int })) },
  }),
  get("core", "/api/v1/postings/{id}", {
    tag: "postings",
    summary: "Get a posting",
    auth: "optional",
    description: "Open postings are visible to everyone. Closed or draft postings are visible only to members of the owning company (404 otherwise). Member fields are present only for company members. Records a view for signed-in users.",
    params: [pathParam("id")],
    responses: { 200: ok(ref("PostingDetail")) },
  }),
  patch("core", "/api/v1/postings/{id}", {
    tag: "postings",
    summary: "Update a posting",
    description: "Verified company members only. Optimistic concurrency via expectedRevision (409 REVISION_CONFLICT with details.currentRevision). A closed posting cannot be set back to OPEN.",
    params: [pathParam("id")],
    body: body(obj({ expectedRevision: int, ...postingWriteFields }, ["expectedRevision"])),
    responses: { 200: ok(ref("PostingDetail")) },
  }),
  get("core", "/api/v1/postings/{id}/applicant-counts", {
    tag: "postings",
    summary: "Applicant counts by stage",
    auth: "optional",
    description: "Company members of the posting only; others (including guests) get 404.",
    params: [pathParam("id")],
    responses: { 200: ok(obj({ total: int, applied: int, screening: int, interview: int, offer: int, rejected: int })) },
  }),
  get("core", "/api/v1/postings/{id}/applicants", {
    tag: "postings",
    summary: "List applicants of a posting",
    description: "Company members of the posting only (404 otherwise). Ordered by appliedAt desc. No page.total.",
    params: [pathParam("id"), ...pageParams, query("stage", applicationStage, "Exact stage filter")],
    responses: { 200: okPage(ref("Applicant")) },
  }),
  get("core", "/api/v1/postings/{id}/applicants/{applicationId}", {
    tag: "postings",
    summary: "Get an applicant",
    description: "Company members of the posting only. Marks the application as seen by the company.",
    params: [pathParam("id"), pathParam("applicationId")],
    responses: { 200: ok(ref("ApplicantDetail")) },
  }),
  patch("core", "/api/v1/postings/{id}/applicants/{applicationId}", {
    tag: "postings",
    summary: "Change an applicant's stage",
    description: "Company members of the posting only. Same stage returns the application unchanged. Applications in ACCEPTED, REJECTED or WITHDRAWN return 409 INVALID_TRANSITION. Sends an APPLICATION_STAGE notification to the applicant.",
    params: [pathParam("id"), pathParam("applicationId")],
    body: body(obj({ stage: enumOf("SCREENING", "INTERVIEW", "OFFER", "REJECTED") })),
    responses: { 200: ok(ref("PostingsApplicantApplication")) },
  }),
  get("core", "/api/v1/postings/{id}/applicants/{applicationId}/files/{fileId}", {
    tag: "postings",
    summary: "Download an applicant's attached file",
    description: "Company members of the posting only. Content-Type is the stored MIME type of the file; Content-Disposition is attachment.",
    params: [pathParam("id"), pathParam("applicationId"), pathParam("fileId")],
    responses: { 200: binary("application/octet-stream") },
  }),
  post("core", "/api/v1/postings/{id}/apply", {
    tag: "postings",
    summary: "Apply to a posting",
    description: "Open postings only; EMPLOYER accounts get 403. Creates a job, an application, document snapshots and file copies. If the caller already applied, returns the existing application with 201. Every documentId / sourceId must belong to the caller (404 otherwise).",
    params: [pathParam("id")],
    body: body(obj({ documentIds: arr(uuid), sourceIds: arr(uuid) }, [])),
    responses: { 201: ok(ref("Application"), "Created") },
  }),
  post("core", "/api/v1/postings/{id}/bookmark", {
    tag: "postings",
    summary: "Bookmark a posting",
    description: "Open postings only. Idempotent.",
    params: [pathParam("id")],
    responses: { 204: noContent },
  }),
  del("core", "/api/v1/postings/{id}/bookmark", {
    tag: "postings",
    summary: "Remove a posting bookmark",
    params: [pathParam("id")],
    responses: { 204: noContent },
  }),
  post("core", "/api/v1/postings/{id}/close", {
    tag: "postings",
    summary: "Close a posting",
    description: "Verified company members only. Sets status CLOSED and closedAt. 409 REVISION_CONFLICT when already closed or expectedRevision is stale.",
    params: [pathParam("id")],
    body: body(obj({ expectedRevision: int })),
    responses: { 200: ok(ref("PostingDetail")) },
  }),
  get("core", "/api/v1/companies/me/postings", {
    tag: "postings",
    summary: "List my company's postings",
    description: "All statuses unless filtered. 404 when the caller is not a company member. page.total is included.",
    params: [...pageParams, query("status", postingStatus)],
    responses: { 200: okPage(ref("PostingsCompanyPosting")) },
  }),
  get("core", "/api/v1/search", {
    tag: "postings",
    summary: "Search postings, people or posts",
    auth: "optional",
    description: "type=postings returns Posting items, type=people returns Profile items, type=posts returns Post items. people and posts require a bearer token (401 for guests). Results are ranked by relevance; page.total is included. The term is recorded for trending.",
    params: [
      requiredQuery("q", { type: "string", minLength: 1 }, "Search term (must not be blank)"),
      query("type", { type: "string", enum: ["postings", "people", "posts"], default: "postings" }),
      ...pageParams,
      query("category", csv("type=people only: comma-separated job categories")),
      query("tenure", csv("type=people only: comma-separated tenure buckets: 0-2, 3-5, 6-9, 10+")),
      query("status", csv("type=people only: comma-separated career statuses: satisfied, seeking, feedback")),
      query("explore", enumOf("recommended", "offers"), "type=people only"),
    ],
    responses: { 200: okPage(ref("SearchResult")) },
  }),
  get("core", "/api/v1/search/counts", {
    tag: "postings",
    summary: "Result counts per search type",
    auth: "optional",
    params: [requiredQuery("q", { type: "string", minLength: 1, maxLength: 200 }, "Search term (must not be blank)")],
    responses: { 200: ok(obj({ postings: int, people: int, posts: int })) },
  }),
  get("core", "/api/v1/search/trending", {
    tag: "postings",
    summary: "Trending search terms and skills",
    auth: "optional",
    description: "terms: top 8 search terms of the last 7 days. skills: skill counts across open postings.",
    responses: { 200: ok(obj({ terms: arr(obj({ term: str, count: int })), skills: arr(facetItem) })) },
  }),
];

const memberFields: Record<string, Schema> = {
  status: postingStatus,
  applicantCount: int,
  newApplicantCount: { type: "integer", description: "Applicants the company has not opened yet" },
  createdBy: nullable(obj({ displayName: str })),
};

export const schemas: Record<string, Schema> = {
  Posting: obj({
    id: uuid,
    company: str,
    title: str,
    jobCategory,
    imageUrl: nullable(str),
    skills: arr(str),
    careerMin: int,
    careerMax: nullable(int),
    location: str,
    employmentType,
    deadline: nullable(date),
    bookmarked: bool,
    applied: bool,
    sourceUrl: nullable(str),
    createdAt: dateTime,
    revision: int,
    closedAt: nullable(dateTime),
    status: postingStatus,
  }, ["id", "company", "title", "jobCategory", "imageUrl", "skills", "careerMin", "careerMax", "location", "employmentType", "deadline", "bookmarked", "applied", "sourceUrl", "createdAt", "revision", "closedAt"]),
  PostingDetail: {
    allOf: [
      ref("Posting"),
      obj({
        description: str,
        requirements: arr(str),
        workConditions: { type: "object", additionalProperties: true },
        preferred: arr(str),
        ...memberFields,
      }, ["description", "requirements", "workConditions", "preferred", "applicantCount"]),
    ],
    description: "status, newApplicantCount and createdBy are present only for members of the owning company (always present on create, update and close responses).",
  },
  PostingsCompanyPosting: {
    allOf: [ref("Posting"), obj(memberFields)],
  },
  Applicant: obj({
    applicationId: uuid,
    applicant: obj({
      displayName: str,
      headline: nullable(str),
      jobCategory: nullable(str),
      tenureYears: nullable(int),
      avatarUrl: nullable(str),
    }),
    documents: arr(obj({ title: str, pages: nullable(int) })),
    stage: applicationStage,
    appliedAt: dateTime,
  }),
  PostingsApplicantApplication: obj({
    id: uuid,
    revision: int,
    jobId: uuid,
    company: str,
    title: str,
    stage: applicationStage,
    appliedAt: nullable(dateTime),
    nextActionAt: nullable(dateTime),
    imported: bool,
    createdAt: dateTime,
    updatedAt: dateTime,
    fitScore: nullable(num),
  }),
  ApplicantDetail: obj({
    application: ref("PostingsApplicantApplication"),
    documents: arr(obj({ id: uuid, title: str, content: str })),
    applicant: obj({
      displayName: str,
      email: str,
      headline: str,
      careers: arr(any),
      skills: arr(str),
    }),
  }),
  SearchResult: {
    oneOf: [ref("Posting"), ref("Profile"), ref("Post")],
    description: "Posting for type=postings, Profile for type=people, Post for type=posts.",
  },
};
