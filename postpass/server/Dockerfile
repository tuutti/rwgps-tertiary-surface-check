FROM golang:1.24-bookworm AS build
ARG POSTPASS_COMMIT=0a424b94ff719de75418876bbda1af4a1ac651a5
WORKDIR /src
RUN git clone https://github.com/woodpeck/postpass.git . \
 && git checkout "$POSTPASS_COMMIT" \
 && CGO_ENABLED=0 go build -o /postpass-server ./cmd/postpass

FROM gcr.io/distroless/static-debian12
COPY --from=build /postpass-server /postpass-server
EXPOSE 8081
ENTRYPOINT ["/postpass-server"]
