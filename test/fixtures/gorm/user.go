package models

type User struct {
	ID          int32    `gorm:"primaryKey"`
	Posts       []Post   `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	EditedPosts []Post   `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	Profile     *Profile `gorm:"constraint:OnDelete:CASCADE"`
}

func (User) TableName() string { return "auth_user" }
