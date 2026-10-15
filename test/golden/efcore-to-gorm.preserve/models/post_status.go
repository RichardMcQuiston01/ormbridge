package models

// PostStatus is a database enum, stored as text.
type PostStatus string

const (
	PostStatusDraft     PostStatus = "Draft"
	PostStatusPublished PostStatus = "Published"
)
