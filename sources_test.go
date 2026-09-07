package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func uploadSource(t *testing.T, s *Server, name string, body []byte) map[string]any {
	t.Helper()
	var encoded bytes.Buffer
	form := multipart.NewWriter(&encoded)
	file, e := form.CreateFormFile("file", name)
	if e != nil {
		t.Fatal(e)
	}
	file.Write(body)
	form.WriteField("kind", "RESUME")
	form.Close()
	r := httptest.NewRequest("POST", "/api/v1/sources", &encoded)
	r.Header.Set("Content-Type", form.FormDataContentType())
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Idempotency-Key", uuid.NewString())
	w := httptest.NewRecorder()
	s.Echo.ServeHTTP(w, r)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var v map[string]any
	json.Unmarshal(w.Body.Bytes(), &v)
	return data(v)
}
func plainPDF(text string) []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.4\n")
	stream := "BT /F1 12 Tf 40 100 Td (" + text + ") Tj ET"
	objects := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(stream), stream), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"}
	offsets := []int{0}
	for i, obj := range objects {
		offsets = append(offsets, b.Len())
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 6\n0000000000 65535 f \n")
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&b, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", xref)
	return b.Bytes()
}
func TestActualDOCXAndPDFExtraction(t *testing.T) {
	s := testApp(t)
	var docx bytes.Buffer
	z := zip.NewWriter(&docx)
	file, _ := z.Create("word/document.xml")
	file.Write([]byte(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>경력</w:t></w:r></w:p><w:p><w:r><w:t>Go API 응답 시간을 20% 줄였습니다.</w:t></w:r></w:p></w:body></w:document>`))
	z.Close()
	for _, fixture := range []struct {
		name, format, text string
		body               []byte
	}{{"resume.docx", "DOCX", "Go API 응답 시간을 20% 줄였습니다.", docx.Bytes()}, {"resume.pdf", "PDF", "Built reliable APIs", plainPDF("Built reliable APIs")}} {
		source := uploadSource(t, s, fixture.name, fixture.body)
		result := opResult(t, request(t, s, "POST", "/career-evidence/import", map[string]any{"sourceId": id(source), "format": fixture.format}, 202)).(map[string]any)
		evidence := result["evidence"].([]any)
		found := false
		for _, raw := range evidence {
			ev := raw.(map[string]any)
			if strings.Contains(ev["sourceText"].(string), fixture.text) {
				found = true
			}
		}
		if !found {
			t.Fatalf("actual source text not extracted: %v", result)
		}
	}
}
func TestGitHubImportUsesProviderSource(t *testing.T) {
	s := testApp(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/example/project":
			json.NewEncoder(w).Encode(map[string]any{"full_name": "example/project", "description": "실제 저장소 설명", "language": "Go", "html_url": "https://github.com/example/project"})
		case "/repos/example/project/readme":
			json.NewEncoder(w).Encode(map[string]any{"encoding": "base64", "content": "IyBQcm9qZWN0CkJ1aWx0IHJlbGlhYmxlIEFQSXMu"})
		default:
			http.Error(w, "unexpected", 404)
		}
	}))
	defer provider.Close()
	s.HTTP = &http.Client{Transport: redirectTransport{target: provider.Listener.Addr().String()}}
	result := opResult(t, request(t, s, "POST", "/career-evidence/import", map[string]any{"format": "GITHUB", "sourceUrl": "https://github.com/example/project"}, 202)).(map[string]any)
	if len(result["evidence"].([]any)) == 0 {
		t.Fatal("empty import")
	}
}
func TestImportedPositionsKeepImmutableExtraction(t *testing.T) {
	s := testApp(t)
	source := uploadSource(t, s, "notes.txt", []byte("경력\n\nAPI 응답 시간을 줄였습니다."))
	first := opResult(t, request(t, s, "POST", "/career-evidence/import", map[string]any{"sourceId": id(source), "format": "TEXT"}, 202)).(map[string]any)
	evidence := first["evidence"].([]any)[1].(map[string]any)
	location := evidence["provenance"].(map[string]any)["sourceLocation"].(map[string]any)
	var original string
	s.DB.QueryRow(context.Background(), "SELECT extracted_text FROM source_files WHERE id=$1", id(source)).Scan(&original)
	if string([]rune(original)[int(location["start"].(float64)):int(location["end"].(float64))]) != evidence["sourceText"] {
		t.Fatal("provenance positions lost")
	}
	request(t, s, "POST", "/career-evidence/import", map[string]any{"sourceId": id(source), "format": "TEXT", "text": "Invented replacement"}, 409)
}
