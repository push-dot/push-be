package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"github.com/labstack/echo/v4"
	"io"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type boundedOutput struct {
	bytes.Buffer
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("extracted text exceeds limit")
	}
	return b.Buffer.Write(p)
}
func extractFile(ctx context.Context, mimeType string, body []byte) (string, error) {
	switch mimeType {
	case "text/plain", "text/markdown":
		return string(body), nil
	case "application/pdf":
		binary, e := exec.LookPath("pdftotext")
		if e != nil {
			return "", fail(503, "NOT_CONFIGURED", "PDF 텍스트 추출기 pdftotext가 필요합니다")
		}
		deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(deadline, binary, "-enc", "UTF-8", "-layout", "-nopgbrk", "-", "-")
		cmd.Stdin = bytes.NewReader(body)
		output := &boundedOutput{limit: 1 << 20}
		cmd.Stdout = output
		cmd.Stderr = io.Discard
		if e = cmd.Run(); e != nil {
			return "", invalid("PDF를 읽을 수 없습니다. 암호/파일 형식을 확인하세요")
		}
		return strings.TrimSpace(output.String()), nil
	case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		archive, e := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if e != nil {
			return "", invalid("DOCX ZIP 오류")
		}
		output := &boundedOutput{limit: 1 << 20}
		found := false
		for _, file := range archive.File {
			if file.Name != "word/document.xml" && file.Name != "word/_rels/document.xml.rels" {
				continue
			}
			if file.UncompressedSize64 > 20<<20 {
				return "", invalid("압축 해제된 DOCX 크기 초과")
			}
			reader, e := file.Open()
			if e != nil {
				return "", e
			}
			decoder := xml.NewDecoder(io.LimitReader(reader, 20<<20))
			textNode := false
			links := []string{}
			for {
				token, e := decoder.Token()
				if e == io.EOF {
					break
				}
				if e != nil {
					reader.Close()
					return "", invalid("DOCX XML 오류")
				}
				switch token := token.(type) {
				case xml.StartElement:
					if token.Name.Local == "t" {
						textNode = true
						found = true
					}
					if token.Name.Local == "tab" {
						if _, e = output.Write([]byte("\t")); e != nil {
							reader.Close()
							return "", invalid("추출 텍스트 크기 초과")
						}
					}
					if oneOf(token.Name.Local, "br", "cr") {
						output.Write([]byte("\n"))
					}
					if token.Name.Local == "Relationship" {
						target, kind := "", ""
						for _, attr := range token.Attr {
							if attr.Name.Local == "Target" {
								target = attr.Value
							}
							if attr.Name.Local == "Type" {
								kind = attr.Value
							}
						}
						if strings.HasSuffix(kind, "/hyperlink") && target != "" && validURL(target) {
							links = append(links, target)
						}
					}
				case xml.EndElement:
					if token.Name.Local == "t" {
						textNode = false
					}
					if token.Name.Local == "p" {
						if _, e = output.Write([]byte("\n\n")); e != nil {
							reader.Close()
							return "", invalid("추출 텍스트 크기 초과")
						}
					}
				case xml.CharData:
					if textNode {
						if _, e = output.Write([]byte(token)); e != nil {
							reader.Close()
							return "", invalid("추출 텍스트 크기 초과")
						}
					}
				}
			}
			reader.Close()
			for _, link := range links {
				if _, e = output.Write([]byte("\n\n" + link)); e != nil {
					return "", invalid("추출 텍스트 크기 초과")
				}
			}
		}
		if !found {
			return "", nil
		}
		return strings.TrimSpace(output.String()), nil
	}
	return "", invalid("추출을 지원하지 않는 형식입니다")
}
func (s *Server) githubSource(c echo.Context, sourceURL string) (string, error) {
	u, e := url.Parse(sourceURL)
	if e != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", invalid("GitHub 프로필 또는 저장소 HTTPS URL이 필요합니다")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 1 || len(parts) > 2 {
		return "", invalid("GitHub 프로필 또는 저장소 루트 URL을 사용하세요")
	}
	for _, part := range parts {
		if !regexp.MustCompile(`^[A-Za-z0-9_.-]+$`).MatchString(part) || oneOf(part, ".", "..") {
			return "", invalid("GitHub 경로 오류")
		}
	}
	headers := map[string]string{"X-GitHub-Api-Version": "2022-11-28"}
	var encrypted []byte
	if e = s.q(c).QueryRow(c.Request().Context(), "SELECT ciphertext FROM github_connections WHERE owner_id=$1", owner(c)).Scan(&encrypted); e == nil {
		key, e := s.decrypt(encrypted, owner(c)+":github")
		if e != nil {
			return "", e
		}
		headers["Authorization"] = "Bearer " + string(key)
	} else if e.Error() != "no rows in result set" {
		return "", e
	}
	if len(parts) == 1 {
		profile, e := s.providerRequest(c.Request().Context(), "GET", "https://api.github.com/users/"+parts[0], nil, headers)
		if e != nil {
			return "", e
		}
		return str(profile, "login") + "\n" + str(profile, "name") + "\n" + str(profile, "bio") + "\n" + str(profile, "html_url"), nil
	}
	base := "https://api.github.com/repos/" + parts[0] + "/" + parts[1]
	repo, e := s.providerRequest(c.Request().Context(), "GET", base, nil, headers)
	if e != nil {
		return "", e
	}
	text := str(repo, "full_name") + "\n" + str(repo, "description") + "\n" + str(repo, "html_url")
	if language := str(repo, "language"); language != "" {
		text += "\nRepository language: " + language
	}
	readme, e := s.providerRequest(c.Request().Context(), "GET", base+"/readme", nil, headers)
	if e != nil {
		return "", e
	}
	if str(readme, "encoding") != "base64" {
		return "", fail(502, "PROVIDER_ERROR", "GitHub README 인코딩 오류")
	}
	raw, e := base64.StdEncoding.DecodeString(strings.ReplaceAll(str(readme, "content"), "\n", ""))
	if e != nil {
		return "", fail(502, "PROVIDER_ERROR", "GitHub README 해석 오류")
	}
	if len(raw) > 400000 {
		return "", invalid("GitHub README 크기 초과")
	}
	return text + "\n\n" + string(raw), nil
}
