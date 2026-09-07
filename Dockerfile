FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /push-api .
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 push
USER push
COPY --from=build /push-api /usr/local/bin/push-api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/push-api"]
