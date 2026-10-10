package models

import "time"

// BlogCategory maps to the "blog_category" table.
type BlogCategory struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null"`
	Name      string    `gorm:"size:100;not null;unique"`
	Slug      string    `gorm:"size:50;not null"`
	ParentID  *int32

	Parent         *BlogCategory  `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
	BlogCategories []BlogCategory `gorm:"foreignKey:ParentID;constraint:OnDelete:SET NULL"`
	BlogPosts      []BlogPost     `gorm:"foreignKey:CategoryID;constraint:blog_post_category_id_fkey,OnDelete:RESTRICT"`
}

// TableName overrides GORM's default table name (blog_categories).
func (BlogCategory) TableName() string {
	return "blog_category"
}
