<?php

declare(strict_types=1);

namespace App\Entity;

use DateTimeImmutable;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'blog_post')]
#[ORM\UniqueConstraint(columns: ['author_id', 'title'])]
#[ORM\Index(columns: ['title'])]
#[ORM\Index(name: 'post_pub_status_idx', columns: ['published_at', 'status'])]
class Post extends TimeStamped
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\Column(name: 'public_id', type: Types::GUID, unique: true, options: ['default' => 'gen_random_uuid()'])]
    private string $publicId;

    #[ORM\Column(type: Types::STRING, length: 200)]
    private string $title;

    #[ORM\Column(type: Types::TEXT)]
    private string $body = '';

    #[ORM\Column(enumType: PostStatus::class, options: ['default' => 'draft'])]
    private PostStatus $status = PostStatus::Draft;

    #[ORM\Column(type: Types::DECIMAL, precision: 4, scale: 2, nullable: true)]
    private ?string $rating = null;

    #[ORM\Column(name: 'view_count', type: Types::INTEGER, options: ['default' => 0])]
    private int $viewCount = 0;

    #[ORM\Column(name: 'is_featured', type: Types::BOOLEAN, options: ['default' => false])]
    private bool $isFeatured = false;

    #[ORM\Column(name: 'published_at', type: Types::DATETIMETZ_IMMUTABLE, options: ['default' => 'CURRENT_TIMESTAMP'])]
    private DateTimeImmutable $publishedAt;

    /** @var array<string, mixed> */
    #[ORM\Column(type: Types::JSON, options: ['default' => '{}'])]
    private array $metadata = [];

    #[ORM\ManyToOne(targetEntity: User::class, inversedBy: 'posts')]
    #[ORM\JoinColumn(name: 'author_id', nullable: false, onDelete: 'CASCADE')]
    private User $author;

    #[ORM\ManyToOne(targetEntity: User::class, inversedBy: 'editedPosts')]
    #[ORM\JoinColumn(name: 'editor_id', nullable: true, onDelete: 'SET NULL')]
    private ?User $editor = null;

    #[ORM\ManyToOne(targetEntity: Category::class)]
    #[ORM\JoinColumn(name: 'category_id', nullable: false, onDelete: 'RESTRICT')]
    private Category $category;

    /** @var Collection<int, Tag> */
    #[ORM\ManyToMany(targetEntity: Tag::class, inversedBy: 'posts')]
    private Collection $tags;

    public function __construct()
    {
        parent::__construct();
        $this->publishedAt = new DateTimeImmutable();
        $this->tags = new ArrayCollection();
    }
}
