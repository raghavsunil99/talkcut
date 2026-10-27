#!/bin/sh
# Builds the face finder used by auto-framing (needs the Xcode command line tools).
set -e
cd "$(dirname "$0")/../vendor/facedetect"
# macOS 13 or later, so the app also runs on older Macs.
xcrun swiftc -O -target arm64-apple-macos13 -o facedetect main.swift
echo "Built vendor/facedetect/facedetect"
