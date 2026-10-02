// The release image reference PV publishes (Story 68.2 AC-9). container-publish.yml builds every
// image as `${IMAGE_NAMESPACE}/<name>:<version>` with `IMAGE_NAMESPACE: ghcr.io/${{ github.repository }}`
// and the release version (the tag without `v`); docker/metadata-action lowercases the name.
// scripts/check-container-publish-workflow.test.ts pins the workflow to these constants, so the
// web-host compatibility manifest and the published image can never name different tags.

export const RELEASE_IMAGE_REGISTRY = 'ghcr.io'
/** The literal `IMAGE_NAMESPACE` value in container-publish.yml. */
export const RELEASE_IMAGE_NAMESPACE_EXPRESSION = `${RELEASE_IMAGE_REGISTRY}/\${{ github.repository }}`
/** The literal `images:` value of container-publish.yml's metadata step. */
export const RELEASE_IMAGE_NAME_EXPRESSION = '${{ env.IMAGE_NAMESPACE }}/${{ matrix.name }}'
/** The repository container-publish.yml runs in when no GITHUB_REPOSITORY is set (local runs). */
export const DEFAULT_RELEASE_REPOSITORY = 'nestormata/project-vault'

/** `ghcr.io/<owner>/<repo>/<image>:<version>`, exactly as container-publish.yml tags it. */
export function releaseImageRef(repository: string, image: string, version: string): string {
  return `${RELEASE_IMAGE_REGISTRY}/${repository.toLowerCase()}/${image}:${version}`
}
