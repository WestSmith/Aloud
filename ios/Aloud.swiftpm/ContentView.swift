import SwiftUI
import UIKit

struct ContentView: View {

    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            // Matches --bg in the effective native/web appearance.
            Color(uiColor: WebViewContainer.backingColor)
                .ignoresSafeArea()

            switch model.state {
            case .starting:
                ProgressView()
                    .tint(.primary)
                    .controlSize(.large)

            case .local(let url):
                WebViewContainer(source: url) { message in
                    model.fail(message)
                }
                    .ignoresSafeArea(edges: .bottom)

            case .failed(let message):
                VStack(spacing: 12) {
                    Text("Aloud couldn't start")
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text("Your saved documents have not been reset.")
                        .font(.subheadline)
                    HStack {
                        Button("Retry") { model.retry() }
                            .buttonStyle(.borderedProminent)
                        Button("Copy diagnostics") { UIPasteboard.general.string = model.diagnostics }
                            .buttonStyle(.bordered)
                    }
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                    DisclosureGroup("Troubleshooting") {
                        Text("Check free storage, then retry. If this keeps happening, reopen Aloud and include the diagnostic text when asking for help.")
                            .font(.footnote)
                    }
                }
                .padding(32)
            }
        }
    }
}
