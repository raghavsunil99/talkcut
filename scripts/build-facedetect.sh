#!/bin/sh
# Builds the face finder used by auto-framing (needs the Xcode command line tools).
set -e
cd "$(dirname "$0")/../vendor/facedetect"
xcrun swiftc -O -o facedetect main.swift
echo "Built vendor/facedetect/facedetect"
