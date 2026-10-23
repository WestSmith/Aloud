import SwiftUI

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
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(32)
            }
        }
    }
}
