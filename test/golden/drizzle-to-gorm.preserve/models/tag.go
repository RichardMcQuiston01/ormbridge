package models

// Tag maps to the "blog_tag" table.
type Tag struct {
	ID    int32  `gorm:"primaryKey;autoIncrement"`
	Label string `gorm:"size:50;not null"`

	Posts []PostTag `gorm:"foreignKey:TagID;constraint:OnDelete:CASCADE"`
}

// TableName overrides GORM's default table name (tags).
func (Tag) TableName() string {
	return "blog_tag"
}
