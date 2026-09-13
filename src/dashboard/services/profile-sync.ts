interface UpdateResult {
  error: { message?: string } | null
}

export async function syncInstagram({
  sellerId,
  userId,
  instagram,
  updateSeller,
  updateUser,
}: {
  sellerId: string
  userId: string
  instagram: string
  updateSeller: (sellerId: string, instagram: string) => Promise<UpdateResult>
  updateUser: (userId: string, instagram: string) => Promise<UpdateResult>
}): Promise<void> {
  const sellerResult = await updateSeller(sellerId, instagram)
  if (sellerResult.error) {
    throw new Error(sellerResult.error.message || 'Não foi possível salvar o Instagram no perfil.')
  }

  const userResult = await updateUser(userId, instagram)
  if (userResult.error) {
    throw new Error(userResult.error.message || 'Não foi possível salvar o Instagram no usuário.')
  }
}
