package models

// BlogUser maps to the "blog_user" table.
type BlogUser struct {
	ID int32 `gorm:"primaryKey;autoIncrement"`

	AuthorBlogPosts []BlogPost   `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	EditorBlogPosts []BlogPost   `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	BlogProfile     *BlogProfile `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (blog_users).
func (BlogUser) TableName() string {
	return "blog_user"
}
